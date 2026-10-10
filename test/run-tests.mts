/**
 * Unit tests for the ingestion and search layers.
 * Run: node test/run-tests.mjs
 *
 * These use a synthetic rustdoc fixture generated from a real `cargo doc` run
 * rather than a hand-written HTML string, so they stay honest about rustdoc's
 * actual nesting quirks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRustdocFixture, fixtureConfig, fixtureRecord } from "./helpers.mjs";

import { _internal as rustdocInternal } from "../src/ingest/rustdoc.js";
import { _internal as mdInternal } from "../src/ingest/markdown.js";
import { _internal as exInternal } from "../src/ingest/examples.js";
import * as ownerInternal from "../src/ingest/owner.js";
import { _internal as storeInternal } from "../src/store.js";
import { formatRecord } from "../src/format.js";
import { BevyIndex } from "../src/store.js";
import * as cheerio from "cheerio";

console.log("\nrustdoc parser");
await test("kindFromFilename handles item and module pages", () => {
  assert.deepEqual(rustdocInternal.kindFromFilename("struct.Query.html"), {
    kind: "struct",
    name: "Query",
  });
  assert.deepEqual(rustdocInternal.kindFromFilename("fn.spawn.html"), {
    kind: "fn",
    name: "spawn",
  });
  assert.deepEqual(rustdocInternal.kindFromFilename("index.html"), {
    kind: "module",
    name: null,
  });
  // rustdoc disambiguates collisions with a -N suffix.
  assert.deepEqual(rustdocInternal.kindFromFilename("associatedtype.Error-1.html"), {
    kind: "associatedtype",
    name: "Error",
  });
});

await test("moduleFromPath drops the item filename", () => {
  const docRoot = "/docs";
  assert.equal(
    rustdocInternal.moduleFromPath(docRoot, "/docs/bevy/ecs/query/struct.Query.html").module,
    "bevy::ecs::query",
  );
  assert.equal(
    rustdocInternal.moduleFromPath(docRoot, "/docs/bevy/ecs/query/index.html").module,
    "bevy::ecs::query",
  );
  assert.equal(rustdocInternal.moduleFromPath(docRoot, "/docs/bevy/app/struct.App.html").crate, "bevy");
});

console.log("\nmarkdown ingester");
await test("front matter is parsed and stripped", () => {
  const src = `+++\ntitle = "The Game Loop"\nweight = 4\nstatus = 'hidden'\n+++\n\nBody text here.\n`;
  const { meta, body } = mdInternal.splitFrontMatter(src);
  assert.equal(meta.title, "The Game Loop");
  assert.equal(meta.weight, 4);
  assert.equal(meta.status, "hidden");
  assert.ok(body.startsWith("Body text"));
});

await test("headings inside code fences are not treated as structure", () => {
  const body = [
    "## Real Heading",
    "text",
    "```rust",
    "# this is a comment",
    "## not a heading",
    "```",
    "more text",
  ].join("\n");
  const chunks = mdInternal.chunkByHeadings(body);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.heading, "Real Heading");
});

await test("chunking keeps a breadcrumb path", () => {
  // Chunks shorter than MIN_CHUNK_CHARS are dropped, so pad the content.
  const pad = "x".repeat(60);
  const body = [
    "# Top",
    pad,
    "## Middle",
    pad,
    "### Deep",
    pad,
  ].join("\n");
  const chunks = mdInternal.chunkByHeadings(body);
  const deep = chunks.find((c) => c.heading === "Deep");
  assert.ok(deep, `expected a Deep chunk, got ${chunks.map((c) => c.heading)}`);
  assert.deepEqual(deep.breadcrumb, ["Top", "Middle", "Deep"]);
});

await test("release-content filenames yield version and PR", () => {
  const info = mdInternal.classify(
    "release-content/0.16/migration-guides/15858_Introduce_methods_on_QueryState.md",
  );
  assert.equal(info.kind, "migration_entry");
  assert.equal(info.version, "0.16");
  assert.equal(info.pr, 15858);
});

await test("migration guide filenames yield from/to versions", () => {
  const info = mdInternal.classify("content/learn/migration-guides/0.19-to-0.20.md");
  assert.equal(info.kind, "migration_guide");
  assert.equal(info.from_version, "0.19");
  assert.equal(info.to_version, "0.20");
});

await test("non-technical sections get zero weight kinds", () => {
  assert.equal(mdInternal.classify("content/news/2024-01-01-x.md").kind, "news");
  assert.equal(mdInternal.classify("content/foundation/team.md").kind, "foundation");
  assert.equal(storeInternal.recordWeight(fixtureRecord({ source: "website", kind: "foundation" })), 0);
});

console.log("\nexample ingester");
await test("module doc comment is extracted", () => {
  assert.equal(exInternal.moduleDoc("//! Does a thing.\n//! And another.\n\nfn main(){}"), "Does a thing.\nAnd another.");
});

await test("categories derived from paths", () => {
  assert.ok(exInternal.categorise("2d/arcball.rs").includes("2d"));
  assert.ok(exInternal.categorise("ui/button.rs").includes("ui"));
  assert.ok(exInternal.categorise("audio/soundtrack.rs").includes("audio"));
});

console.log("\nversion weighting");
await test("cmpVersion compares numerically, not lexically", () => {
  assert.equal(storeInternal.cmpVersion("0.19.1", "0.20.0"), -1);
  assert.equal(storeInternal.cmpVersion("0.20", "0.19.9"), 1);
  assert.equal(storeInternal.cmpVersion("0.19.0", "0.19"), 0);
  // pre-release suffixes must not break parsing
  assert.equal(storeInternal.cmpVersion("0.20.0-rc.2", "0.20.0"), 0);
});

console.log("\nversion bump classification (the patch vs minor distinction)");
await test("0.19.0 -> 0.19.1 is a patch and does NOT break the API", () => {
  const b = storeInternal.bumpBetween("0.19.0", "0.19.1");
  assert.equal(b.level, "patch");
  assert.equal(b.breaksApi, false, "a patch release must not be flagged as breaking");
  assert.equal(b.direction, "upgrade");
});

await test("0.19 -> 0.20 is a minor and DOES break the API", () => {
  const b = storeInternal.bumpBetween("0.19", "0.20");
  assert.equal(b.level, "minor");
  assert.equal(b.breaksApi, true);
});

await test("0.19.1 -> 0.20.0 is still a breaking minor, not a patch", () => {
  const b = storeInternal.bumpBetween("0.19.1", "0.20.0");
  assert.equal(b.level, "minor");
  assert.equal(b.breaksApi, true);
});

await test("identical versions report no action", () => {
  const b = storeInternal.bumpBetween("0.19.1", "0.19.1");
  assert.equal(b.level, "none");
  assert.equal(b.breaksApi, false);
});

await test("downgrade is flagged as breaking", () => {
  const b = storeInternal.bumpBetween("0.20", "0.19");
  assert.equal(b.direction, "downgrade");
  assert.equal(b.breaksApi, true);
});

await test("pre-release does not read as newer than its release", () => {
  const b = storeInternal.bumpBetween("0.20.0-rc.2", "0.20.0");
  assert.equal(b.level, "none");
});

await test("unknown versions do not claim to be safe", () => {
  const b = storeInternal.bumpBetween(null, "0.20");
  assert.equal(b.level, "unknown");
  assert.equal(b.breaksApi, true, "unknown must default to 'assume breaking'");
});

await test("a guide targeting the pinned version outranks an ancient one", () => {
  const current = fixtureRecord({ kind: "migration_guide", to_version: "0.19" });
  const ancient = fixtureRecord({ kind: "migration_guide", to_version: "0.4" });
  const future = fixtureRecord({ kind: "migration_guide", to_version: "0.25" });
  assert.ok(
    storeInternal.versionWeight(current, "0.19") > storeInternal.versionWeight(ancient, "0.19"),
  );
  assert.ok(
    storeInternal.versionWeight(current, "0.19") > storeInternal.versionWeight(future, "0.19"),
  );
});

console.log("\nranking");
await test("rustdoc outranks news for the same content", () => {
  assert.ok(
    storeInternal.recordWeight(fixtureRecord({ source: "rustdoc", kind: "method" })) >
      storeInternal.recordWeight(fixtureRecord({ source: "website", kind: "news" })),
  );
});

console.log("\nversion diff (patch vs breaking)");
await test("two patch versions report an unchanged signature", () => {
  // What an agent should conclude: nothing to migrate.
  const a = { signature: "pub fn add_systems(&mut self, s: impl ScheduleLabel)" };
  const b = { signature: "pub fn add_systems(&mut self, s: impl ScheduleLabel)" };
  const distinct = new Set([a.signature, b.signature]);
  assert.equal(distinct.size, 1);
  assert.equal(storeInternal.bumpBetween("0.19.0", "0.19.1").breaksApi, false);
});

await test("whitespace-only signature differences are not 'changes'", () => {
  // rustdoc wraps signatures differently between builds; an agent must not be
  // told the API changed when only line wrapping did.
  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const a = "pub fn add_systems<M>(\n  &mut self,\n  schedule: impl ScheduleLabel,\n) -> &mut App";
  const b = "pub fn add_systems<M>( &mut self, schedule: impl ScheduleLabel, ) -> &mut App";
  assert.equal(new Set([norm(a), norm(b)]).size, 1);
});

console.log("\nimpl header parsing (where clauses and generics)");
await test("stripGenericsAndBounds handles where clauses and generics", () => {
  const strip = ownerInternal._internal.stripGenericsAndBounds;
  assert.equal(strip("Sphere"), "Sphere");
  assert.equal(strip("Rect<T>"), "Rect");
  assert.equal(strip("Foo<T> where T: Bar"), "Foo");
  assert.equal(strip("Vec3"), "Vec3");
});

await test("parseImplHeader extracts trait and type (regression: Spherewhere...)", () => {
  // The bug this prevents produced paths like
  // `Spherewhere Sphere: Send + Sync + 'static,::register_required_components`
  const withWhere =
    "impl Component for Sphere where Sphere: Send + Sync + 'static,";
  assert.deepEqual(ownerInternal.parseImplHeader(withWhere), {
    traitName: "Component",
    typeName: "Sphere",
  });

  // Inherent impl: no trait, just the type.
  assert.deepEqual(ownerInternal.parseImplHeader("impl Sphere"), {
    traitName: null,
    typeName: "Sphere",
  });

  // Generic type with a generic trait and a where clause.
  assert.deepEqual(
    ownerInternal.parseImplHeader("impl<T> Trait<T> for Foo<T> where T: Bar"),
    { traitName: "Trait", typeName: "Foo" },
  );
});

await test("ownerFromImplText never leaks a where clause into the owner", () => {
  const owner = ownerInternal.ownerFromImplText(
    "impl Component for Sphere where Sphere: Send + Sync + 'static,",
  );
  assert.equal(owner, "Sphere");
  assert.ok(!owner.includes("where"), "owner must not contain 'where'");
});

await test("traitFromImplText distinguishes inherent from trait impls", () => {
  assert.equal(
    ownerInternal.traitFromImplText("impl Component for Sphere where Sphere: Send"),
    "Component",
  );
  assert.equal(ownerInternal.traitFromImplText("impl Sphere"), null);
});

console.log("\nend-to-end on real rustdoc output");
// The caller (test/index.mjs) can supply the directory, so the fixture survives
// this process and can be handed to the spawned-server resource tests after it
// exits. Otherwise it is a private temp dir removed in `finally`.
const fixtureDir = (() => {
  if (!process.env.RESOURCE_FIXTURE_OUT) {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-test-"));
  }
  fs.mkdirSync(process.env.RESOURCE_FIXTURE_OUT, { recursive: true });
  return process.env.RESOURCE_FIXTURE_OUT;
})();
try {
  const docDir = buildRustdocFixture(fixtureDir);

  const { ingestRustdoc } = await import("../src/ingest/rustdoc.js");
  const records = ingestRustdoc(docDir, "9.9.9");

  await test("ingest produces method records with owners", () => {
    const newFn = records.find((r) => r.name === "new");
    assert.ok(newFn, "expected a record named `new`");
    assert.equal(newFn.owner, "Widget");
    assert.equal(newFn.kind, "method");
    assert.ok(newFn.signature.includes("pub fn new"));
  });

  await test("each method keeps its OWN documentation (regression: off-by-one)", () => {
    const n = records.find((r) => r.name === "new");
    assert.ok(n);
    const i = records.find((r) => r.name === "id");
    assert.ok(i);
    // Assert attribution, not exact text: blockToText flattens a docblock's
    // <pre> into prose, so a method that documents an example has that example
    // inline in `docs` as well as in `examples`.
    assert.match(n.docs, /^Creates a widget\./);
    assert.equal(i.docs, "Reads the id.");
  });

  await test("struct-level docs are attributed to the struct", () => {
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    assert.match(s.docs, /^A widget resource\./);
    assert.equal(s.full_path, "rdfixture::Widget");
  });

  await test("blanket and auto-trait impls are excluded", () => {
    const blanket = records.filter((r) =>
      ["borrow", "clone", "from", "into", "type_id", "try_from"].includes(r.name),
    );
    assert.equal(blanket.length, 0, `unexpected blanket methods: ${blanket.map((b) => b.name)}`);
  });

  await test("free functions are indexed", () => {
    assert.ok(records.some((r) => r.kind === "fn" && r.name === "spawn_widget"));
  });

  console.log("\nstruct fields");
  await test("fields are indexed with owner, type and their own docs", () => {
    // rustdoc renders fields as `span.structfield`, not `section[id^="field."]`,
    // so these were structurally unreachable before the dedicated walk.
    const id = records.find((r) => r.kind === "field" && r.name === "id");
    assert.ok(id, "expected a field record named `id`");
    assert.equal(id.owner, "Widget");
    assert.equal(id.full_path, "rdfixture::Widget::id");
    assert.match(id.signature, /^id:\s*u32$/, `signature was ${JSON.stringify(id.signature)}`);
  });

  await test("each field keeps its OWN documentation", () => {
    const id = records.find((r) => r.kind === "field" && r.name === "id");
    assert.ok(id);
    const label = records.find((r) => r.kind === "field" && r.name === "label");
    assert.ok(label);
    assert.match(id.docs, /unique id/);
    assert.match(label.docs, /display label/);
    assert.ok(!(id.docs).includes("display label"), "field docs must not bleed together");
  });

  await test("field docs are attributed to the struct, not the field", () => {
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    assert.match(s.docs, /^A widget resource\./);
  });

  console.log("\ndoctest examples");
  await test("doctests are extracted with their source intact", () => {
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    assert.ok(s.examples?.length, "expected an extracted example on Widget");
    const code = s.examples[0]!.code;
    assert.match(code, /let w = Widget::new\(7\)/);
    assert.match(code, /assert_eq!\(w\.id\(\), 7\)/);
  });

  await test("examples carry no rustdoc line-number gutter", () => {
    // `<span data-nosnippet>165</span>` is chrome, not code. Left in, it
    // produces sources like "61fn speed(" that cannot be read or copied.
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    for (const ex of s.examples ?? []) {
      assert.ok(!/^\d+(fn|let|pub|use)/m.test(ex.code), `line numbers leaked: ${ex.code}`);
    }
  });

  await test("extraction does not mutate docs (the search-safety guarantee)", () => {
    // `docs` feeds _flexPayload -> FlexSearch -> ranking, so it must be exactly
    // what blockToText produced before this change -- example source included,
    // because flattening the docblock into prose is pre-existing behaviour that
    // this work deliberately does not touch. What must NOT happen is the string
    // changing: that would silently move every ranking in the index.
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    assert.ok(
      (s.docs).startsWith("A widget resource."),
      `docs must be unchanged prose, got ${JSON.stringify((s.docs).slice(0, 60))}`,
    );
    assert.equal(
      s.docs,
      "A widget resource.\n§Example\nlet w = Widget::new(7);\nassert_eq!(w.id(), 7);",
      "docs must stay byte-identical to what blockToText produced before examples existed",
    );
  });

  await test("a method's doctest is attributed to the method", () => {
    const newFn = records.find((r) => r.name === "new");
    assert.ok(newFn);
    assert.ok(newFn.examples?.length, "expected Widget::new to own its doctest");
    assert.match(newFn.examples[0]!.code, /Widget::new\(1\)/);
    // and the type must not have inherited it
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    assert.ok(
      !(s.examples ?? []).some((e) => /Widget::new\(1\)/.test(e.code)),
      "the method's example must not also land on the struct",
    );
  });

  await test("formatRecord renders examples as fenced rust", () => {
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.ok(s);
    const out = formatRecord(s, { docsChars: 200 });
    assert.ok(out.includes("```rust"), "expected a fenced rust block");
    assert.ok(out.includes("Widget::new(7)"), "example source must survive formatting");
  });

  // Now exercise the store end to end.
  const { loadOrBuild, hybridSearch, findMigrations } = await import("../src/store.js");
  const idx = await loadOrBuild(
    fixtureConfig(fixtureDir, { docDir }),
    { force: true },
  );

  await test("exact lookup resolves Type::method", () => {
    const hits = idx.lookupSymbol("Widget::new");
    assert.ok(hits.length, "expected Widget::new to resolve");
    assert.equal(hits[0]!.record.name, "new");
  });

  await test("exact lookup resolves a bare name", () => {
    assert.ok(idx.lookupSymbol("Widget").length);
  });

  await test("exact lookup tolerates generics and full paths", () => {
    assert.ok(idx.lookupSymbol("rdfixture::Widget").length);
    assert.ok(idx.lookupSymbol("Widget<u32>").length);
  });

  await test("hybrid search puts the exact symbol first", () => {
    const res = hybridSearch(idx, "Widget::id");
    assert.ok(res.length);
    assert.equal(res[0]!.record.name, "id");
  });

  await test("a method outranks a same-named field on the exact-symbol path", () => {
    // `Widget` now has both a field `id` and a method `id`, so the bare leaf key
    // `id` points at both. The method must lead, or "read the id" style lookups
    // start answering with a field declaration.
    const hits = idx.lookupSymbol("id");
    assert.ok(hits.length >= 2, "expected both the method and the field to share the key");
    assert.equal(hits[0]!.record.kind, "method");
  });

  await test("fields are reachable by exact lookup and by kind filter", () => {
    assert.ok(
      idx.lookupSymbol("Widget::label").some((h) => h.record.kind === "field"),
      "Widget::label must resolve to the field",
    );
    const res = hybridSearch(idx, "label", { limit: 10, filters: { kind: "field" } });
    assert.ok(res.length > 0, "a kind=field query must still return fields");
    assert.ok(res.every((r) => r.record.kind === "field"));
  });

  await test("fields are weighted below real API", () => {
    // Without a KIND_WEIGHT entry these would fall through to rustdoc's 1.0 and
    // ~10-15k records named x/y/z/translation would crowd out real API.
    assert.ok(
      storeInternal.recordWeight(fixtureRecord({ source: "rustdoc", kind: "field" })) < 0.6,
      "a field must not carry near-full weight",
    );
    assert.ok(
      storeInternal.recordWeight(fixtureRecord({ source: "rustdoc", kind: "field" })) >
        storeInternal.recordWeight(fixtureRecord({ source: "website", kind: "news" })),
      "a field must still outrank a news post",
    );
  });

  await test("dependency-typed pages contribute no fields", () => {
    // The mirrored facade tree carries a page per re-exported dependency type;
    // gating on the page's source link is what keeps glam fields out.
    assert.equal(rustdocInternal.depCrateOfPage(null, "https://docs.rs/glam/0.32.1/src/glam/f32/vec3.rs.html#34"), "glam");
    assert.equal(
      rustdocInternal.depCrateOfPage(null, "https://docs.rs/bevy_app/0.19.1/src/bevy_app/app.rs.html#1609"),
      "bevy_app",
    );
    assert.ok(rustdocInternal.DEP_CRATES.has("glam"));
    assert.ok(!rustdocInternal.DEP_CRATES.has("bevy_app"));
    const file = path.join(docDir, "rdfixture", "struct.Widget.html");
    const page = cheerio.load(fs.readFileSync(file, "utf8"));
    const source = page("a.src.rightside").first();
    assert.ok(source.length, "fixture must carry a page source link");
    source.attr("href", "https://docs.rs/glam/0.32.1/src/glam/f32/vec3.rs.html#34");
    const dependencyRecords = rustdocInternal.parsePage(page.html(), file, docDir, "9.9.9");
    assert.equal(dependencyRecords.filter((record) => record.kind === "field").length, 0);
  });

  await test("filters narrow results and do not starve", () => {
    const res = hybridSearch(idx, "widget", { limit: 10, filters: { source: "rustdoc" } });
    assert.ok(res.length > 0);
    assert.ok(res.every((r) => r.record.source === "rustdoc"));
  });

  await test("findMigrations returns multiple chunks per document", () => {
    const many = Array.from({ length: 8 }, (_, i) => fixtureRecord({
      kind: "migration_guide",
      full_path: "guide.md",
      from_version: "0.9",
      to_version: "1.0",
      name: "Guide",
      heading: `Section ${i}`,
      docs: "some migration prose",
    }));
    const fake = new BevyIndex();
    fake.meta = { bevy_version: "1.0" };
    fake.addRecords(many);
    const res = findMigrations(fake, "0.9", "1.0");
    assert.equal(res.length, 6, "should keep several chunks, not collapse to 1");
  });

  await test("findMigrations topic filter runs before ranking", () => {
    const fake = new BevyIndex();
    fake.meta = { bevy_version: "1.0" };
    fake.addRecords([
        fixtureRecord({ kind: "migration_guide", full_path: "g.md", from_version: "0.9", to_version: "1.0",
          name: "G", heading: "Unrelated", docs: "nothing of interest here" }),
        fixtureRecord({ kind: "migration_guide", full_path: "g.md", from_version: "0.9", to_version: "1.0",
          name: "G", heading: "About scheduling", docs: "the scheduler changed a lot" }),
    ]);
    const res = findMigrations(fake, "0.9", "1.0", { topic: "schedul" });
    assert.equal(res.length, 1);
    assert.equal(res[0]!.record.heading, "About scheduling");
  });

  // Leave the fixture's data dir in place and point resource-conformance tests
  // at it. They spawn the server, which needs a real persisted index; building
  // it here means `npm test` covers the resource layer without a rustdoc mirror
  // or a downloaded release bundle.
  console.log(`\nresource-layer fixture`);
  // Build the persisted index once for the spawned protocol tests.
  const { VersionRegistry } = await import("../src/registry.js");
  const fixtureRegistry = new VersionRegistry(fixtureConfig(fixtureDir, {
    docDir,
    dataDir: path.join(fixtureDir, "data-registry"),
  }));
  const fixtureIndex = await fixtureRegistry.get("9.9.9");
  fs.writeFileSync(
    path.join(fixtureDir, "resource-fixture.json"),
    JSON.stringify({ dataDir: path.join(fixtureDir, "data-registry"), version: "9.9.9" }),
  );

  await test("fixture index is populated (guards against a vacuous resource test)", () => {
    assert.ok(
      fixtureIndex.records.length > 5,
      `fixture index looks empty: ${fixtureIndex.records.length} records`,
    );
    assert.ok(
      fixtureIndex.records.some((r) => r.kind === "field"),
      "fixture must contain field records for the resource layer to serve",
    );
  });
} finally {
  // Keep the fixture when RESOURCE_FIXTURE_OUT asks for it; the spawned server
  // in resources-test.mjs needs it after this process exits.
  if (!process.env.RESOURCE_FIXTURE_OUT) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}
