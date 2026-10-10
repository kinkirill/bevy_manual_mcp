/** Parse rustdoc HTML into separate item, field and example records. */

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

/** Dependency field exclusions; keep in sync with src/store.ts. */
const DEP_CRATES = new Set(["glam", "bevy_reflect", "bevy_math"]);

// Struct fields use span.structfield markup and are walked separately.
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

/** Find item docs inside the section or beside its wrapper, avoiding later item descendants. */
function docblockFor($: CheerioAPI, el: AnyNode, skipSelector: string) {
  const inside = $(el).find(".docblock").first();
  if (inside.length) return inside;

  let node = $(el);
  for (let depth = 0; depth < 6 && node.length; depth++) {
    const next = node.nextAll(".docblock").first();
    if (next.length) return next;

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

/** Capture type-specific Default documentation omitted by the external-trait filter. */
function defaultImplDoc($: CheerioAPI, skipSelector: string) {
  const impl = $('section[id^="impl-Default-for-"]');
  if (!impl.length) return "";
  const fn = $('section[id="method.default"], section[id^="method.default-"]').first();
  const node = (fn.length ? fn : impl.first())[0];
  const doc = node ? docblockFor($, node, skipSelector) : null;
  const text = doc && doc.length ? normalizeSpace(blockToText(doc)) : "";
  // Inherited trait prose does not describe this type's default value.
  if (!text || /^returns the .?default value.? for a type/i.test(text)) return "";
  return text;
}

/** Parse a named struct-field span with a name: Type header; otherwise return null. */
function fieldFromSpan($: CheerioAPI, el: AnyNode, { crate, module, relFile, owner, bevyVersion, sourceRef }: {
  crate: string; module: string; file: string; relFile: string; owner: string | null; bevyVersion: string | null; sourceRef: string | null;
}): RustdocRecord | null {
  const id = $(el).attr("id") || "";
  const name = id.replace(/^structfield\./, "");
  if (!name) return null;

  // Tuple fields would pollute symbol lookup with numeric names; the type retains their declaration.
  if (/^\d+$/.test(name)) return null;

  const code = $(el).children("code").first();
  if (!code.length) return null;
  // Read rendered text because the field type may be linked markup.
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
    // Fields inherit the page's defining-source link.
    source_ref: sourceRef,
    bevy_version: bevyVersion,
    title: "",
  };
}

/** Identify the defining crate from its source URL, including facade re-exports. */
function depCrateOfPage($: CheerioAPI | null, srcLink: string | null) {
  const ref = String(srcLink || "");
  if (ref.includes("rust-lang.org")) return "std";
  const m = ref.match(/docs\.rs\/([a-z0-9_]+)\//);
  return m ? m[1] : null;
}

/**
 * Item docs sit beside their section inside details; its summary identifies the owner.
 * Return null for type-level examples.
 */
function itemForExample($: CheerioAPI, el: AnyNode) {
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

  // Impl headers can be preceding siblings rather than ancestors.
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

/** Rustdoc marks trait-impl methods with the trait-impl class. */
function isTraitImplMethod($: CheerioAPI, el: AnyNode) {
  return $(el).hasClass("trait-impl");
}

/** Return the enclosing impl's trait name, or null for an inherent impl. */
function traitNameFromImpl($: CheerioAPI, el: AnyNode) {
  const implSection = enclosingImpl($, el);
  if (!implSection) return null;
  const hdr = $(implSection).children("h3.code-header").first();
  if (!hdr.length) return null;
  const $c = hdr.clone();
  $c.find(".where").remove();
  return traitFromImplText($c.text());
}

/** Standard traits excluded from item records. */
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
  // Accept crate-local and Bevy-qualified traits.
  if (traitName.includes("::")) {
    const head = traitName.split("::")[0] ?? "";
    return head === crate || head.startsWith("bevy");
  }
  // Retain unrecognized bare traits to avoid discarding real API.
  return true;
}

/** Resolve the owner from an enclosing or preceding impl header. */
function ownerFromImpl($: CheerioAPI, el: AnyNode) {
  const implSection = enclosingImpl($, el);
  if (!implSection) return null;
  // Remove nested where bounds before reading the owning type.
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
      defaults: defaultImplDoc($, skipSel) || undefined,
      file: relFile,
      source_ref: srcLink,
      bevy_version: bevyVersion,
      title,
    });
  }

  $("section[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (!id || !ITEM_SECTION_RE.test(id)) return;
    if (isNoise($, el)) return;

    const kind = itemKindFromSectionId(id);

    // Exclude external trait-impl boilerplate while retaining crate-local impls.
    if (isTraitImplMethod($, el)) {
      const traitName = traitNameFromImpl($, el);
      if (!traitIsLocal(traitName, crate)) return;
    }
    const name = sectionName(id ?? "");
    if (!name) return;

    const signature = codeHeaderOf($, el);
    const docEl = docblockFor($, el, skipSel);
    const docs = docEl && docEl.length ? clip(blockToText(docEl)) : "";
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

  // Facade pages re-export dependency types; source links decide whether to ingest fields.
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
        sourceRef: pageSrcLink,
      });
      if (rec) records.push(rec);
    });
  }

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

  // Keep structured examples separate from prose used for search ranking.
  const examples: { example: DocExample; $el: Cheerio<AnyNode> }[] = [];
  // Restrict to example markup so item declarations are excluded.
  $("pre.rust-example-rendered, pre.ignore, pre.compile_fail, .example-wrap pre.rust").each(
    (_, el) => {
      const $pre = $(el);
      const code = $pre.children("code").first();
      const $code = code.length ? code : $pre;
      // Remove rustdoc's line-number spans before reading code.
      $code.find("span[data-nosnippet]").remove();
      const src = $code.text().replace(/\r/g, "");
      if (!src.trim()) return;
      const scraped = $pre.closest(".scraped-example");
      const title = scraped.length
        ? scraped.find(".scraped-example-title").first().text().trim() || null
        : null;
      const example = {
        lang: "rust",
        compile_fail: $pre.hasClass("compile_fail"),
        ignored: $pre.hasClass("ignore"),
        scraped: scraped.length > 0,
        source_file: title,
        code: src.replace(/\n+$/, ""),
      };
      examples.push({ example, $el: $(el) });
    },
  );

  // Attach examples to their owning item, falling back to the type-level record.
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

/** Skip static and oversized index pages before HTML parsing. */
function isIndexablePage(file: string, size: number) {
  const base = path.basename(file);
  if (base === "all.html" || base === "help.html" || base === "settings.html") {
    return false;
  }
  if (base === "index.html" && size > 400 * 1024) return false;
  return true;
}

/** Ingest rustdoc item records, optionally restricted to selected crates. */
export function ingestRustdoc(docDir: string | null, bevyVersion: string | null, { includeCrates = null }: { includeCrates?: string[] | null } = {}): RustdocRecord[] {
  if (!docDir || !fs.existsSync(docDir)) return [];
  return [...streamRustdoc(docDir, bevyVersion, { includeCrates })];
}

/** Yield one page's records at a time to bound HTML ingestion memory. */
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
        // Bound persisted documentation size independently of display truncation.
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
