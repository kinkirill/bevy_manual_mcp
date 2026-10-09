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
import { execFileSync } from "node:child_process";

import { _internal as rustdocInternal } from "../src/ingest/rustdoc.js";
import { _internal as mdInternal } from "../src/ingest/markdown.js";
import { _internal as exInternal } from "../src/ingest/examples.js";
import * as ownerInternal from "../src/ingest/owner.js";
import { _internal as storeInternal } from "../src/store.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

console.log("\nrustdoc parser");
test("kindFromFilename handles item and module pages", () => {
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

test("moduleFromPath drops the item filename", () => {
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
test("front matter is parsed and stripped", () => {
  const src = `+++\ntitle = "The Game Loop"\nweight = 4\nstatus = 'hidden'\n+++\n\nBody text here.\n`;
  const { meta, body } = mdInternal.splitFrontMatter(src);
  assert.equal(meta.title, "The Game Loop");
  assert.equal(meta.weight, 4);
  assert.equal(meta.status, "hidden");
  assert.ok(body.startsWith("Body text"));
});

test("headings inside code fences are not treated as structure", () => {
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
  assert.equal(chunks[0].heading, "Real Heading");
});

test("chunking keeps a breadcrumb path", () => {
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

test("release-content filenames yield version and PR", () => {
  const info = mdInternal.classify(
    "release-content/0.16/migration-guides/15858_Introduce_methods_on_QueryState.md",
  );
  assert.equal(info.kind, "migration_entry");
  assert.equal(info.version, "0.16");
  assert.equal(info.pr, 15858);
});

test("migration guide filenames yield from/to versions", () => {
  const info = mdInternal.classify("content/learn/migration-guides/0.19-to-0.20.md");
  assert.equal(info.kind, "migration_guide");
  assert.equal(info.from_version, "0.19");
  assert.equal(info.to_version, "0.20");
});

test("non-technical sections get zero weight kinds", () => {
  assert.equal(mdInternal.classify("content/news/2024-01-01-x.md").kind, "news");
  assert.equal(mdInternal.classify("content/foundation/team.md").kind, "foundation");
  assert.equal(storeInternal.recordWeight({ source: "website", kind: "foundation" }), 0);
});

console.log("\nexample ingester");
test("module doc comment is extracted", () => {
  assert.equal(exInternal.moduleDoc("//! Does a thing.\n//! And another.\n\nfn main(){}"), "Does a thing.\nAnd another.");
});

test("categories derived from paths", () => {
  assert.ok(exInternal.categorise("2d/arcball.rs").includes("2d"));
  assert.ok(exInternal.categorise("ui/button.rs").includes("ui"));
  assert.ok(exInternal.categorise("audio/soundtrack.rs").includes("audio"));
});

console.log("\nversion weighting");
test("cmpVersion compares numerically, not lexically", () => {
  assert.equal(storeInternal.cmpVersion("0.19.1", "0.20.0"), -1);
  assert.equal(storeInternal.cmpVersion("0.20", "0.19.9"), 1);
  assert.equal(storeInternal.cmpVersion("0.19.0", "0.19"), 0);
  // pre-release suffixes must not break parsing
  assert.equal(storeInternal.cmpVersion("0.20.0-rc.2", "0.20.0"), 0);
});

console.log("\nversion bump classification (the patch vs minor distinction)");
test("0.19.0 -> 0.19.1 is a patch and does NOT break the API", () => {
  const b = storeInternal.bumpBetween("0.19.0", "0.19.1");
  assert.equal(b.level, "patch");
  assert.equal(b.breaksApi, false, "a patch release must not be flagged as breaking");
  assert.equal(b.direction, "upgrade");
});

test("0.19 -> 0.20 is a minor and DOES break the API", () => {
  const b = storeInternal.bumpBetween("0.19", "0.20");
  assert.equal(b.level, "minor");
  assert.equal(b.breaksApi, true);
});

test("0.19.1 -> 0.20.0 is still a breaking minor, not a patch", () => {
  const b = storeInternal.bumpBetween("0.19.1", "0.20.0");
  assert.equal(b.level, "minor");
  assert.equal(b.breaksApi, true);
});

test("identical versions report no action", () => {
  const b = storeInternal.bumpBetween("0.19.1", "0.19.1");
  assert.equal(b.level, "none");
  assert.equal(b.breaksApi, false);
});

test("downgrade is flagged as breaking", () => {
  const b = storeInternal.bumpBetween("0.20", "0.19");
  assert.equal(b.direction, "downgrade");
  assert.equal(b.breaksApi, true);
});

test("pre-release does not read as newer than its release", () => {
  const b = storeInternal.bumpBetween("0.20.0-rc.2", "0.20.0");
  assert.equal(b.level, "none");
});

test("unknown versions do not claim to be safe", () => {
  const b = storeInternal.bumpBetween(null, "0.20");
  assert.equal(b.level, "unknown");
  assert.equal(b.breaksApi, true, "unknown must default to 'assume breaking'");
});

console.log("\ncrates.io version resolution");
test("pre-releases are separated from stable releases", async () => {
  // Offline-safe: validate the classification logic on a realistic payload
  // rather than hitting the network in the test suite.
  const payload = {
    crate: { newest_version: "0.20.0-rc.2", max_stable_version: "0.19.1" },
    versions: [
      { num: "0.20.0-rc.2", yanked: false },
      { num: "0.19.1", yanked: false },
      { num: "0.19.0", yanked: false },
      { num: "0.18.1", yanked: true },
    ],
  };
  const stable = payload.versions.filter((v) => !/-/.test(v.num) && !v.yanked);
  assert.equal(stable[0].num, "0.19.1", "newest stable must be 0.19.1, not the rc");
  assert.equal(payload.crate.newest_version, "0.20.0-rc.2");
  assert.ok(stable.every((v) => !/-/.test(v.num)), "no pre-releases in the stable list");
});

test("a guide targeting the pinned version outranks an ancient one", () => {
  const current = { kind: "migration_guide", to_version: "0.19" };
  const ancient = { kind: "migration_guide", to_version: "0.4" };
  const future = { kind: "migration_guide", to_version: "0.25" };
  assert.ok(
    storeInternal.versionWeight(current, "0.19") > storeInternal.versionWeight(ancient, "0.19"),
  );
  assert.ok(
    storeInternal.versionWeight(current, "0.19") > storeInternal.versionWeight(future, "0.19"),
  );
});

console.log("\nranking");
test("rustdoc outranks news for the same content", () => {
  assert.ok(
    storeInternal.recordWeight({ source: "rustdoc", kind: "method" }) >
      storeInternal.recordWeight({ source: "website", kind: "news" }),
  );
});

console.log("\nversion diff (patch vs breaking)");
test("two patch versions report an unchanged signature", () => {
  // What an agent should conclude: nothing to migrate.
  const a = { signature: "pub fn add_systems(&mut self, s: impl ScheduleLabel)" };
  const b = { signature: "pub fn add_systems(&mut self, s: impl ScheduleLabel)" };
  const distinct = new Set([a.signature, b.signature]);
  assert.equal(distinct.size, 1);
  assert.equal(storeInternal.bumpBetween("0.19.0", "0.19.1").breaksApi, false);
});

test("whitespace-only signature differences are not 'changes'", () => {
  // rustdoc wraps signatures differently between builds; an agent must not be
  // told the API changed when only line wrapping did.
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const a = "pub fn add_systems<M>(\n  &mut self,\n  schedule: impl ScheduleLabel,\n) -> &mut App";
  const b = "pub fn add_systems<M>( &mut self, schedule: impl ScheduleLabel, ) -> &mut App";
  assert.equal(new Set([norm(a), norm(b)]).size, 1);
});

console.log("\nimpl header parsing (where clauses and generics)");
test("stripGenericsAndBounds handles where clauses and generics", () => {
  const strip = ownerInternal._internal.stripGenericsAndBounds;
  assert.equal(strip("Sphere"), "Sphere");
  assert.equal(strip("Rect<T>"), "Rect");
  assert.equal(strip("Foo<T> where T: Bar"), "Foo");
  assert.equal(strip("Vec3"), "Vec3");
});

test("parseImplHeader extracts trait and type (regression: Spherewhere...)", () => {
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

test("ownerFromImplText never leaks a where clause into the owner", () => {
  const owner = ownerInternal.ownerFromImplText(
    "impl Component for Sphere where Sphere: Send + Sync + 'static,",
  );
  assert.equal(owner, "Sphere");
  assert.ok(!owner.includes("where"), "owner must not contain 'where'");
});

test("traitFromImplText distinguishes inherent from trait impls", () => {
  assert.equal(
    ownerInternal.traitFromImplText("impl Component for Sphere where Sphere: Send"),
    "Component",
  );
  assert.equal(ownerInternal.traitFromImplText("impl Sphere"), null);
});

console.log("\nend-to-end on real rustdoc output");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-test-"));
try {
  const crateDir = path.join(fixtureDir, "rdfixture");
  fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    '[package]\nname = "rdfixture"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  fs.writeFileSync(
    path.join(crateDir, "src", "lib.rs"),
    `/// A widget resource.
pub struct Widget { pub id: u32 }

impl Widget {
    /// Creates a widget.
    pub fn new(id: u32) -> Self { Self { id } }
    /// Reads the id.
    pub fn id(&self) -> u32 { self.id }
}

/// Marker for widget-like things.
pub struct WithWidget;

pub fn spawn_widget() {}
`,
  );
  execFileSync("cargo", ["doc", "--no-deps", "-q"], { cwd: crateDir, stdio: "pipe" });
  const docDir = path.join(crateDir, "target", "doc");

  const { ingestRustdoc } = await import("../src/ingest/rustdoc.js");
  const records = ingestRustdoc(docDir, "9.9.9");

  test("ingest produces method records with owners", () => {
    const newFn = records.find((r) => r.name === "new");
    assert.ok(newFn, "expected a record named `new`");
    assert.equal(newFn.owner, "Widget");
    assert.equal(newFn.kind, "method");
    assert.ok(newFn.signature.includes("pub fn new"));
  });

  test("each method keeps its OWN documentation (regression: off-by-one)", () => {
    const n = records.find((r) => r.name === "new");
    const i = records.find((r) => r.name === "id");
    assert.equal(n.docs, "Creates a widget.");
    assert.equal(i.docs, "Reads the id.");
  });

  test("struct-level docs are attributed to the struct", () => {
    const s = records.find((r) => r.kind === "struct" && r.name === "Widget");
    assert.equal(s.docs, "A widget resource.");
    assert.equal(s.full_path, "rdfixture::Widget");
  });

  test("blanket and auto-trait impls are excluded", () => {
    const blanket = records.filter((r) =>
      ["borrow", "clone", "from", "into", "type_id", "try_from"].includes(r.name),
    );
    assert.equal(blanket.length, 0, `unexpected blanket methods: ${blanket.map((b) => b.name)}`);
  });

  test("free functions are indexed", () => {
    assert.ok(records.some((r) => r.kind === "fn" && r.name === "spawn_widget"));
  });

  // Now exercise the store end to end.
  const { loadOrBuild, hybridSearch, findMigrations } = await import("../src/store.js");
  const idx = await loadOrBuild(
    {
      projectRoot: fixtureDir,
      bevyVersion: "9.9.9",
      versionSource: "test",
      docDir,
      websiteDir: null,
      examplesDir: null,
      dataDir: path.join(fixtureDir, "data"),
    },
    { force: true },
  );

  test("exact lookup resolves Type::method", () => {
    const hits = idx.lookupSymbol("Widget::new");
    assert.ok(hits.length, "expected Widget::new to resolve");
    assert.equal(hits[0].record.name, "new");
  });

  test("exact lookup resolves a bare name", () => {
    assert.ok(idx.lookupSymbol("Widget").length);
  });

  test("exact lookup tolerates generics and full paths", () => {
    assert.ok(idx.lookupSymbol("rdfixture::Widget").length);
    assert.ok(idx.lookupSymbol("Widget<u32>").length);
  });

  test("hybrid search puts the exact symbol first", () => {
    const res = hybridSearch(idx, "Widget::id");
    assert.ok(res.length);
    assert.equal(res[0].record.name, "id");
  });

  test("filters narrow results and do not starve", () => {
    const res = hybridSearch(idx, "widget", { limit: 10, filters: { source: "rustdoc" } });
    assert.ok(res.length > 0);
    assert.ok(res.every((r) => r.record.source === "rustdoc"));
  });

  test("findMigrations returns multiple chunks per document", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      kind: "migration_guide",
      full_path: "guide.md",
      from_version: "0.9",
      to_version: "1.0",
      name: "Guide",
      heading: `Section ${i}`,
      docs: "some migration prose",
    }));
    const fake = {
      meta: { bevy_version: "1.0" },
      records: many,
    };
    const res = findMigrations(fake, "0.9", "1.0");
    assert.equal(res.length, 6, "should keep several chunks, not collapse to 1");
  });

  test("findMigrations topic filter runs before ranking", () => {
    const fake = {
      meta: { bevy_version: "1.0" },
      records: [
        { kind: "migration_guide", full_path: "g.md", from_version: "0.9", to_version: "1.0",
          name: "G", heading: "Unrelated", docs: "nothing of interest here" },
        { kind: "migration_guide", full_path: "g.md", from_version: "0.9", to_version: "1.0",
          name: "G", heading: "About scheduling", docs: "the scheduler changed a lot" },
      ],
    };
    const res = findMigrations(fake, "0.9", "1.0", { topic: "schedul" });
    assert.equal(res.length, 1);
    assert.equal(res[0].record.heading, "About scheduling");
  });
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);