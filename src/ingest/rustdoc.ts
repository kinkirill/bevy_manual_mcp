/**
 * Rustdoc HTML parser.
 *
 * rustdoc pages are structured, but the nesting is subtle: an item's <section>
 * closes *before* its <div class="docblock">, because the docblock is a sibling
 * of the <details>/<summary> wrapper rather than a child of the section. So we
 * cannot simply do `$(`section#method.x .docblock`)`. Instead we walk up from
 * the section looking for the first following .docblock, which is robust across
 * rustdoc versions.
 *
 * Emits one record per item so that `Query::iter` is searchable on its own
 * instead of being buried in 1500 characters of struct-level prose.
 */

import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { errorMessage, type DocExample, type RustdocRecord } from "../types.js";
import { ownerFromImplText, traitFromImplText } from "./owner.js";

/** Sections that contain only noise: auto-trait and blanket impls. */
const NOISE_LISTS = [
  "#synthetic-implementations-list",
  "#blanket-implementations-list",
];

/**
 * Dependency crates whose types surface on Bevy types but are not Bevy API.
 *
 * Mirrors DEP_CRATES in src/store.js, which filters dependency-defined
 * *methods*. Fields need the same treatment for a different reason: the mirrored
 * facade tree contains a page per re-exported dependency type, so a glam type
 * contributes its fields to the corpus unless the page is gated.
 */
const DEP_CRATES = new Set(["glam", "bevy_reflect", "bevy_math"]);

// NOTE: `field` is intentionally absent. rustdoc does not render struct fields
// as `section[id^="field."]` -- it uses `span.structfield[id^="structfield."]`.
// They are walked separately in `fieldFromSpan`'s caller. Keeping `field` here
// matched nothing and hid the real shape of the markup.
const ITEM_SECTION_RE =
  /^(method|tymethod|structmethod|structassocfn|associatedconstant|associatedtype|structassociatedconstant|structassociatedtype|tyassociatedconst|tyassociatedtype|assocconst|variant)\./;

const TOP_LEVEL_KINDS = [
  "struct",
  "enum",
  "trait",
  "fn",
  "macro",
  "type",
  "constant",
  "union",
  "primitive",
  "derive",
  "extern",
  "attr",
  "keyword",
  "module",
];

function normalizeSpace(s: string | null | undefined) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Convert a docblock element to compact markdown-ish text. */
function blockToText($el: Cheerio<AnyNode>) {
  return $el
    .text()
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function codeHeaderOf($: CheerioAPI, el: AnyNode) {
  const hdr = $(el).find("h4.code-header").first();
  const own = $(el).children("h4.code-header").first();
  const target = own.length ? own : hdr;
  return target.length ? normalizeSpace(target.text()) : "";
}

/**
 * Find the docblock belonging to `el`.
 *
 * Two rustdoc layouts exist in the wild:
 *   <section id="method.x"><h4>..</h4></section><div class="docblock">  (doc inside)
 *   <details><summary><section id="method.x">..</section></summary>
 *            <div class="docblock">                                   (doc after)
 *
 * We check descendants first, then climb one wrapper at a time and look at the
 * *direct* next sibling. Note: `.nextAll().find('.docblock')` is WRONG here --
 * `nextAll()` already returns the siblings, and `find()` only searches their
 * descendants, so it silently matches the following item's docs instead.
 */
function docblockFor($: CheerioAPI, el: AnyNode, skipSelector: string) {
  const inside = $(el).find(".docblock").first();
  if (inside.length) return inside;

  let node = $(el);
  for (let depth = 0; depth < 6 && node.length; depth++) {
    // The docblock is usually the immediate next sibling of the wrapper.
    const next = node.nextAll(".docblock").first();
    if (next.length) return next;

    // Or the first child of the next wrapper element.
    const wrapped = node.nextAll().first().children(".docblock").first();
    if (wrapped.length) return wrapped;

    node = node.parent();
    if (!node.length) break;
    if (skipSelector && node.is(skipSelector)) return null;
  }
  return null;
}

function isNoise($: CheerioAPI, el: AnyNode) {
  for (const sel of NOISE_LISTS) {
    if ($(el).closest(sel).length) return true;
  }
  return false;
}

/**
 * The doc comment attached to a type's `impl Default for <Type>`.
 *
 * Trait-impl methods from std traits are dropped as boilerplate (see
 * `parsePage`), but `Default` is special: its doc frequently states the *actual*
 * default value -- e.g. Plane3d's "a normal pointing in the +Y direction" --
 * which is exactly the kind of detail a model guesses wrong, and which no other
 * field on the record captures. Returns "" when the impl is undocumented (the
 * common `#[derive(Default)]` case).
 */
function defaultImplDoc($: CheerioAPI, skipSelector: string) {
  const impl = $('section[id^="impl-Default-for-"]');
  if (!impl.length) return "";
  const fn = $('section[id="method.default"], section[id^="method.default-"]').first();
  const node = (fn.length ? fn : impl.first())[0];
  const doc = node ? docblockFor($, node, skipSelector) : null;
  const text = doc && doc.length ? normalizeSpace(blockToText(doc)) : "";
  // Ignore the inherited trait doc ("Returns the default value for a type"),
  // which carries no type-specific information and only adds noise.
  if (!text || /^returns the .?default value.? for a type/i.test(text)) return "";
  return text;
}

/**
 * Parse one `<span class="structfield">` header into a field record.
 *
 * Struct fields are NOT sections. rustdoc renders them as:
 *
 *   <span id="structfield.translation" class="structfield section-header">
 *     <a class="anchor field">§</a>
 *     <code>translation: <a class="struct" href="...">Vec3</a></code>
 *   </span>
 *   <div class="docblock"><p>Position of the entity...</p></div>
 *
 * so the `section[id]` walk used for methods and variants structurally cannot
 * match them -- that is why fields were entirely absent from the index despite
 * `ITEM_SECTION_RE` listing `field`. They need their own walk over spans.
 *
 * Returns null when the span does not carry a `name: Type` code header, which
 * is the only reliable place the field name lives (the id prefix is
 * `structfield.`, not `field.`).
 */
function fieldFromSpan($: CheerioAPI, el: AnyNode, { crate, module, relFile, owner, bevyVersion }: {
  crate: string; module: string; file: string; relFile: string; owner: string | null; bevyVersion: string | null;
}): RustdocRecord | null {
  const id = $(el).attr("id") || "";
  const name = id.replace(/^structfield\./, "");
  if (!name) return null;

  // Tuple struct members are indexed by rustdoc as `structfield.0`, `structfield.1`,
  // ... They carry no name an agent can use, and admitting them would put numeric
  // leaf keys ("0", "1") into the symbol table, where a lookup for a bare digit
  // would return arbitrary members. The declaration itself stays on the type
  // record, so `ActionRequest` still shows `ActionRequest(u32, u32)`.
  if (/^\d+$/.test(name)) return null;

  const code = $(el).children("code").first();
  if (!code.length) return null;
  // `translation: Vec3` -- the type may itself be wrapped in a link, so read the
  // rendered text rather than the raw attribute.
  const decl = normalizeSpace(code.text());
  if (!decl.includes(":")) return null;

  const docEl = docblockFor($, el, NOISE_LISTS.join(", "));
  const docs = docEl && docEl.length ? normalizeSpace(blockToText(docEl)) : "";

  return {
    source: "rustdoc",
    kind: "field",
    name,
    full_path: owner && owner !== "?" ? `${module}::${owner}::${name}` : `${module}::${name}`,
    owner: owner || null,
    crate,
    module,
    signature: decl,
    docs,
    file: relFile,
    // Fields have no per-item source link of their own; the page's link is what
    // identifies the defining crate (see depCrateOf below).
    source_ref: null,
    bevy_version: bevyVersion,
    title: "",
  };
}

/**
 * The dependency crate a whole rustdoc page belongs to, or null if local.
 *
 * Re-exported items land in the mirrored `bevy` facade tree under their
 * original filename, so `bevy/prelude/struct.Vec3.html` is actually glam's
 * Vec3. Its page-level source link is the only reliable signal. Filtering the
 * page once is both cheaper and more accurate than filtering each field: every
 * field on a glam page is a glam field.
 */
function depCrateOfPage($: CheerioAPI | null, srcLink: string | null) {
  const ref = String(srcLink || "");
  if (ref.includes("rust-lang.org")) return "std";
  const m = ref.match(/docs\.rs\/([a-z0-9_]+)\//);
  return m ? m[1] : null;
}

/**
 * The item a doctest belongs to, as { owner, name }.
 *
 * An item's docblock is a SIBLING of its <section>, not a descendant (the
 * nesting quirk documented at the top of this file):
 *
 *   <details class="method-toggle">
 *     <summary><section id="method.new">..</section></summary>
 *     <div class="docblock">..<div class="example-wrap">..
 *
 * So `closest("section[id]")` reaches only `main-content`, and every example
 * would be mis-attributed to the page's top item. The owning section is found
 * by walking up to the enclosing <details> and reading the section inside its
 * <summary>. Returns null for an example in the type-level docblock, which
 * genuinely belongs to the page's own item.
 */
function itemForExample($: CheerioAPI, el: AnyNode) {
  // Walk out to the innermost <details> that wraps an item, then read its summary.
  let sec: Cheerio<AnyNode> | null = null;
  let node = $(el);
  for (let depth = 0; depth < 8 && node.length; depth++) {
    const details = node.is("details") ? node : node.closest("details");
    if (details.length && details.is("details")) {
      const candidate = details.children("summary").find("section[id]").first();
      if (candidate.length && ITEM_SECTION_RE.test(candidate.attr("id") || "")) {
        sec = candidate;
        break;
      }
    }
    node = node.parent();
    if (!node.length) break;
    if (node.is("section#main-content")) break;
  }
  if (!sec) return null;

  const name = sectionName(sec.attr("id") || "");
  if (!name) return null;

  // The type comes from the enclosing impl block, whose header is a preceding
  // sibling section (`<section id="impl-Query-for-X">`).
  let owner = sec[0] ? ownerFromImpl($, sec[0]) : null;
  if (!owner) {
    const impl = sec.closest("details").prevAll("section.impl").first();
    if (impl.length) {
      const hdr = impl.children("h3.code-header").first();
      if (hdr.length) {
        const $c = hdr.clone();
        $c.find(".where").remove();
        owner = ownerFromImplText($c.text());
      }
    }
  }
  return { owner: owner || null, name };
}

function itemKindFromSectionId(id: string) {
  const prefix = id.split(".")[0] ?? "";
  switch (prefix) {
    case "method":
    case "tymethod":
    case "structmethod":
      return "method";
    case "structassocfn":
      return "method";
    case "associatedconstant":
    case "structassociatedconstant":
    case "tyassociatedconst":
    case "assocconst":
      return "associated_const";
    case "associatedtype":
    case "structassociatedtype":
    case "tyassociatedtype":
      return "associated_type";
    case "field":
      return "field";
    case "variant":
      return "variant";
    default:
      return prefix;
  }
}

function sectionName(id: string) {
  const i = id.indexOf(".");
  return i === -1 ? id : id.slice(i + 1);
}

/**
 * Is this method defined by a trait impl rather than an inherent impl?
 * rustdoc marks these with the `trait-impl` class.
 */
function isTraitImplMethod($: CheerioAPI, el: AnyNode) {
  return $(el).hasClass("trait-impl");
}

/**
 * Extract the trait name from the enclosing impl block header, which reads
 * `impl MyTrait for MyType` or `impl<T> MyTrait<T> for MyType`.
 * Returns null for an inherent `impl MyType`.
 */
function traitNameFromImpl($: CheerioAPI, el: AnyNode) {
  const implSection = enclosingImpl($, el);
  if (!implSection) return null;
  const hdr = $(implSection).children("h3.code-header").first();
  if (!hdr.length) return null;
  const $c = hdr.clone();
  $c.find(".where").remove();
  return traitFromImplText($c.text());
}

/**
 * Is a trait defined by the crate being documented?
 *
 * We cannot know every crate's namespace, but a trait reached via an impl whose
 * source link points at the crate under documentation is local. Fallback: the
 * well-known std/core traits, which account for the overwhelming majority of
 * boilerplate, are treated as external.
 */
const STD_TRAITS = new Set([
  "Add", "AddAssign", "AsMut", "AsRef", "Borrow", "BorrowMut", "Clone",
  "Copy", "Debug", "Default", "Deref", "DerefMut", "Display", "Drop",
  "Eq", "Error", "From", "FromIterator", "FromStr", "Hash", "HashMap",
  "Index", "IndexMut", "Into", "IntoIterator", "Iterator", "Ord",
  "PartialEq", "PartialOrd", "Read", "Send", "Sync", "ToOwned",
  "ToString", "Unpin", "Write", "fmt", "std",
]);

function traitIsLocal(traitName: string | null, crate: string) {
  if (!traitName) return false;
  if (STD_TRAITS.has(traitName)) return false;
  // Path-qualified traits (e.g. `bevy_math::RectOps`) are local when they start
  // with the crate under documentation.
  if (traitName.includes("::")) {
    const head = traitName.split("::")[0] ?? "";
    return head === crate || head.startsWith("bevy");
  }
  // A bare name we do not recognise is most likely a std trait we have not
  // enumerated; keeping it costs little and avoids dropping real API.
  return true;
}

/**
 * Determine the owning type for a method so we can build `Query::iter`.
 *
 * rustdoc places the impl block and its methods as *siblings* under a <details>:
 *   <details class="toggle implementors-toggle">
 *     <summary><section id="impl-Query" class="impl">.. impl Query ..</section></summary>
 *     <div class="impl-items"> .. <section id="method.iter" class="method"> ..
 *   </details>
 * so the impl is neither an ancestor nor a descendant of the method. We look
 * for an ancestor impl first, then fall back to a preceding sibling.
 */
function ownerFromImpl($: CheerioAPI, el: AnyNode) {
  const implSection = enclosingImpl($, el);
  if (!implSection) return null;
  // Clone the header and drop the `where` div before reading text: rustdoc
  // nests the where clause inside <h3>, so its bounds ("Sphere: Send + Sync")
  // would otherwise be concatenated onto the type name.
  const hdr = $(implSection).children("h3.code-header").first();
  if (!hdr.length) return null;
  const $c = hdr.clone();
  $c.find(".where").remove();
  return ownerFromImplText($c.text());
}

/** The `<section class="impl">` that owns this method, if any. */
function enclosingImpl($: CheerioAPI, el: AnyNode): AnyNode | null {
  const ancestor = $(el).closest("section.impl");
  if (ancestor.length) return ancestor[0] ?? null;
  let node = $(el);
  for (let depth = 0; depth < 7 && node.length; depth++) {
    const prev = node.prevAll().find("section.impl").first();
    if (prev.length) return prev[0] ?? null;
    node = node.parent();
    if (!node.length) break;
    if (node.is("section#main-content")) break;
  }
  return null;
}

/** Parse `struct.Query-1.html` -> { kind: 'struct', name: 'Query' } */
function kindFromFilename(file: string): { kind: string | null; name: string | null } {
  const base = path.basename(file, ".html");
  if (base === "index" || base === "all") return { kind: "module", name: null };
  if (base === "fnindex" || base === "traitindex") return { kind: null, name: null };
  const m = base.match(/^([a-z_]+)\.(.+?)(?:-\d+)?$/);
  if (!m) return { kind: null, name: null };
  return { kind: m[1] ?? null, name: m[2] ?? null };
}

/** Turn `bevy/ecs/query/struct.Query.html` into module path `bevy::ecs::query`. */
function moduleFromPath(docRoot: string, file: string) {
  const rel = path.relative(docRoot, file).replace(/\\/g, "/");
  const segs = rel.split("/");
  const crate = segs[0] ?? "";
  const rest = segs.slice(1);
  // Drop the page filename. For modules that is `index.html`; for items it is
  // `struct.Query.html`, which must not become part of the module path.
  if (rest.length && /\.html$/.test(rest[rest.length - 1] ?? "")) rest.pop();
  return { crate, module: [crate, ...rest].join("::") };
}

function parsePage(html: string, file: string, docRoot: string, bevyVersion: string | null, { docsChars = 4000 }: { docsChars?: number } = {}): RustdocRecord[] {
  const $ = cheerio.load(html);
  const clip = (t: string) => (t ? (t.length <= docsChars ? t : t.slice(0, docsChars).trimEnd() + " …") : "");
  const { crate, module } = moduleFromPath(docRoot, file);
  const { kind: fileKind, name: fileName } = kindFromFilename(file);
  const relFile = path.relative(docRoot, file).replace(/\\/g, "/");

  const records: RustdocRecord[] = [];
  const skipSel = NOISE_LISTS.join(", ");

  // ---- 1. The top-level item on this page -------------------------------
  if (fileKind && fileKind !== "module" && fileName) {
    const title = normalizeSpace($("h1").first().text()).replace(/\s*§\s*$/, "");
    const decl = normalizeSpace($("pre.item-decl code").first().text());
    const topDoc = $("details.top-doc .docblock").first();
    const docs = topDoc.length ? clip(blockToText(topDoc)) : "";
    const srcLink = $("a.src.rightside").first().attr("href") || null;

    records.push({
      source: "rustdoc",
      kind: fileKind,
      name: fileName,
      full_path: `${module}::${fileName}`,
      owner: null,
      crate,
      module,
      signature: decl || title,
      docs,
      // Only present for types whose `impl Default` carries a doc comment.
      defaults: defaultImplDoc($, skipSel) || undefined,
      file: relFile,
      source_ref: srcLink,
      bevy_version: bevyVersion,
      title,
    });
  }

  // ---- 2. Nested items: methods, assoc items, fields, variants ----------
  $("section[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (!id || !ITEM_SECTION_RE.test(id)) return;
    if (isNoise($, el)) return;

    const kind = itemKindFromSectionId(id);

    // Trait-impl methods are boilerplate, not API.
    //
    // rustdoc lists every trait implementation on a type's page, which for Bevy
    // means ~249k records of `clone`, `fmt`, `borrow`, `reflect_ref`,
    // `type_path` and friends -- 82% of the whole corpus and the direct cause
    // of the index exhausting Node's heap. None of it is something an agent
    // writes or looks up.
    //
    // We keep impls of traits *from this crate* (genuine API, e.g.
    // `impl Add for Vec3`) and drop everything from std/core and other crates
    // (Display, Clone, Default, Reflect, any standard trait).
    if (isTraitImplMethod($, el)) {
      const traitName = traitNameFromImpl($, el);
      if (!traitIsLocal(traitName, crate)) return;
    }
    const name = sectionName(id ?? "");
    if (!name) return;

    const signature = codeHeaderOf($, el);
    const docEl = docblockFor($, el, skipSel);
    const docs = docEl && docEl.length ? clip(blockToText(docEl)) : "";
    // The page's top-level item is the natural owner when no impl block is found.
    const owner = ownerFromImpl($, el) || fileName || null;
    const srcLink = $(el).children("a.src").first().attr("href") || null;

    records.push({
      source: "rustdoc",
      kind,
      name,
      full_path:
        owner && owner !== "?"
          ? `${module}::${owner}::${name}`
          : `${module}::${name}`,
      owner,
      crate,
      module,
      signature,
      docs,
      file: relFile,
      source_ref: srcLink,
      bevy_version: bevyVersion,
      title: "",
    });
  });

  // ---- 3. Struct fields ---------------------------------------------------
  //
  // Gate the whole page on its source link. The mirrored `bevy` facade tree
  // re-exports dependency types under their own filenames, so
  // `bevy/prelude/struct.Vec3.html` is really glam's Vec3 and its three fields
  // (`x`, `y`, `z`) are not Bevy API. Filtering per page is both cheaper and more
  // accurate than filtering per field, and it mirrors the existing DEP_CRATES
  // treatment of dependency-defined methods.
  const pageSrcLink = $("a.src.rightside").first().attr("href") || null;
  const pageDep = depCrateOfPage($, pageSrcLink);
  if (!pageDep || !DEP_CRATES.has(pageDep)) {
    $("span.structfield[id^='structfield.']").each((_, el) => {
      const rec = fieldFromSpan($, el, {
        crate,
        module,
        file,
        relFile,
        owner: fileName || null,
        bevyVersion,
      });
      if (rec) records.push(rec);
    });
  }

  // ---- 4. Enum variants get their own records ---------------------------
  $("section[id^='variant.']").each((_, el) => {
    const id = $(el).attr("id");
    const name = sectionName(id ?? "");
    const docs = clip(blockToText($(el).find(".docblock").first()));
    records.push({
      source: "rustdoc",
      kind: "variant",
      name,
      full_path: `${module}::${fileName}::${name}`,
      owner: fileName,
      crate,
      module,
      signature: "",
      docs,
      file: relFile,
      source_ref: null,
      bevy_version: bevyVersion,
      title: "",
    });
  });

  // ---- 5. Doctest examples ------------------------------------------------
  //
  // Extracted into a SEPARATE `examples` field rather than being folded into
  // `docs`. That separation is the whole safety property: `docs` feeds
  // _flexPayload -> FlexSearch -> ranking, so rewriting it would change recall
  // for every query in the index. Adding a field cannot.
  //
  // `blockToText` flattens a docblock to `.text()`, which turns a doctest into
  // run-on prose with line numbers spliced into it
  // ("fn post_process_system(\n76 view: ViewQuery<("). Reading the inner <code>
  // of the <pre> recovers the source exactly, because the syntax-highlighting
  // <span>s are the only markup inside it.
  const examples: { example: DocExample; $el: Cheerio<AnyNode> }[] = [];
  // Scoped deliberately. A bare `pre.rust` selector also matches
  // `pre.rust.item-decl` -- the type's own declaration (`pub struct
  // MinimalPlugins;`) -- which is not an example. Real doctests live inside
  // `.example-wrap`, carry `rust-example-rendered`, or are `ignore` /
  // `compile_fail` blocks.
  //
  // Examples are attached to their nearest owning item rather than dumped on
  // the page's top record. rustdoc scrapes a matching snippet out of the repo's
  // examples/ into *each method's* docblock, so `struct.App` yields 116 scraped
  // snippets that belong to 116 different methods -- attributing them all to
  // `App` would be wrong and would bloat one record enormously.
  $("pre.rust-example-rendered, pre.ignore, pre.compile_fail, .example-wrap pre.rust").each(
    (_, el) => {
      const $pre = $(el);
      const code = $pre.children("code").first();
      const $code = code.length ? code : $pre;
      // rustdoc's line-number gutter is `<span data-nosnippet>165</span>`, and
      // `.text()` would splice those digits into the source ("61fn speed(").
      // It is presentational chrome, not code, so it is removed before reading.
      $code.find("span[data-nosnippet]").remove();
      const src = $code.text().replace(/\r/g, "");
      if (!src.trim()) return;
      // "Examples found in repository" blocks are scraped from Bevy's own
      // examples/ files and are prefixed with the file they came from. That
      // provenance is worth keeping -- it says the snippet is real, runnable
      // engine code rather than something the author wrote inline.
      const scraped = $pre.closest(".scraped-example");
      const title = scraped.length
        ? scraped.find(".scraped-example-title").first().text().trim()
        : null;
      const example = {
        lang: "rust",
        // `compile_fail` examples demonstrate code that must NOT compile; the
        // marker is the entire point of them, so it is preserved rather than lost.
        compile_fail: $pre.hasClass("compile_fail"),
        ignored: $pre.hasClass("ignore"),
        scraped: scraped.length > 0,
        source_file: title,
        code: src.replace(/\n+$/, ""),
      };
      examples.push({ example, $el: $(el) });
    },
  );

  // Attach each example to the item whose docblock contains it. Examples in the
  // type-level docblock belong to the page's own record. Records are keyed by
  // full_path, which is unique per item within a page.
  const byPath = new Map(records.map((r) => [r.full_path, r]));
  for (const { example, $el } of examples) {
    const item = $el[0] ? itemForExample($, $el[0]) : null;
    const target = item
      ? byPath.get(
          item.owner
            ? `${module}::${item.owner}::${item.name}`
            : `${module}::${item.name}`,
        )
      : null;
    const rec = target || records[0];
    if (rec) (rec.examples ||= []).push(example);
  }

  return records;
}

/** Recursively collect every .html file under `dir`. */
export function walkHtml(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "src" || e.name === ".lock") continue;
      walkHtml(full, out);
    } else if (e.name.endsWith(".html")) {
      if (e.name === "search-index.js") continue;
      out.push(full);
    }
  }
  return out;
}

/**
 /**
 * Cheap pre-filter so we never pay a cheerio parse for a page that cannot
 * contain an item.
 *
 * A full `bevy` facade doc tree is ~1.6 GB across ~7,900 files and takes
 * minutes to parse. These pages are index pages, not items:
 *   all.html        every symbol in one page, duplicated across the tree
 *   help.html       static
 *   index.html      module page: mostly a function list, no item docs
 *   search.index    search metadata, not documentation
 * `index.html` pages ARE still walked into (their function lists are useful),
 * but the giant ones are skipped when they carry no item markup.
 */
function isIndexablePage(file: string, size: number) {
  const base = path.basename(file);
  if (base === "all.html" || base === "help.html" || base === "settings.html") {
    return false;
  }
  // The `all.html`-equivalent index page is megabytes of links and no docs.
  if (base === "index.html" && size > 400 * 1024) return false;
  return true;
}

/**
 * Ingest a cargo target/doc directory. Returns item records.
 * `includeCrates` lets us index only the facade crate for a smaller index.
 */
export function ingestRustdoc(docDir: string | null, bevyVersion: string | null, { includeCrates = null }: { includeCrates?: string[] | null } = {}): RustdocRecord[] {
  if (!docDir || !fs.existsSync(docDir)) return [];
  return [...streamRustdoc(docDir, bevyVersion, { includeCrates })];
}

/**
 * Parse a doc tree as a generator, one page at a time.
 *
 * Yielding instead of accumulating is essential, not a nicety: the `bevy` facade
 * tree is ~1.6 GB of HTML that yields ~200k records. Collecting them into one
 * array exhausts Node's default heap (observed: OOM after ~10 min of GC
 * thrashing). A caller that wants records on disk writes them incrementally;
 * a caller that wants an array spreads this, but should expect to raise
 * --max-old-space-size first.
 *
 * Each page's records are still held only for that page, so peak memory is
 * bounded by the largest single HTML page (rustdoc's biggest is ~6 MB).
 */
export function* streamRustdoc(docDir: string | null, bevyVersion: string | null, { includeCrates = null }: { includeCrates?: string[] | null } = {}): Generator<RustdocRecord> {
  if (!docDir || !fs.existsSync(docDir)) return;

  for (const file of walkHtml(docDir, [])) {
    const { crate } = moduleFromPath(docDir, file);
    if (includeCrates && !includeCrates.includes(crate)) continue;

    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (!isIndexablePage(file, size)) continue;

    let html;
    try {
      html = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      yield* parsePage(html, file, docDir, bevyVersion, {
        // Keep the payload small on disk and in memory. Docs are already
        // truncated for display by the formatter; storing a full 300KB
        // docblock per method only bloats the index (303k records -> ~170 MB).
        docsChars: 2000,
      });
    } catch (err) {
      if (process.env.BEVY_MCP_DEBUG === "1") {
        console.error("[rustdoc] failed:", file, errorMessage(err));
      }
    }
  }
}

export const _internal = {
  parsePage,
  kindFromFilename,
  moduleFromPath,
  docblockFor,
  normalizeSpace,
  fieldFromSpan,
  depCrateOfPage,
  DEP_CRATES,
};
