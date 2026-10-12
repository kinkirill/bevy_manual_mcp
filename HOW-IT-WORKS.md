# How it works

Back to the [README](README.md).

```
bevy-website/content/**             ─┐  book, migration guides, quick-start, FAQ
release-content/<ver>/**            ─┤  per-PR migration notes, release notes
learning-code-examples/**/*.rs      ─┤
cargo target/doc/**/*.html          ─┼─> ingest ──> records ─┐
docs.rs mirror (optional)           ─┘                     │
bevy/examples/**/*.rs              ─┘                     ├─> hybrid index
vendor/bevy-meta/**                 ─┐  feature graph,      │        │
                                       │  plugin gates,      ├─> supplement
                                       │  error codes         │        ▼
vendor/ecosystem/compat.json        ─┘  plugin ↔ Bevy        ┘  FlexSearch (concepts)
                                                 exact symbol table ──> API symbols
                                                 name-token index   ──> subject matches
```

Seven design decisions worth knowing:

**1. Every rustdoc item is its own record.** rustdoc puts a struct's methods in
the *parent's* HTML file, so naive scraping buries them. This parser emits one
record per method and associated item, tagged with its owner, so `Query::iter`
exists as a record in its own right instead of being buried in a wall of prose
inside `Query`'s page.

**2. Exact lookup beats fuzzy.** A symbol table resolves `App::add_systems`
directly; FlexSearch only handles concepts. A purely fuzzy index ranks a
paragraph above the function you're asking for.

**3. Version relevance is a ranking weight.** A migration guide whose target
version equals your pinned version outranks one for 0.4→0.5. Combined with the
"indexed for Bevy X.Y.Z" line on every result, this makes stale answers visible
rather than silent.

**4. Name matches outrank prose matches.** FlexSearch scores any occurrence in
the indexed text, so a query word matching a symbol's *name* is weighted well
above the same word buried in a doc example - and an intent verb ("spawn
camera") is treated as the question, not its subject. That is why
`bevy_search "spawn camera"` leads with `Camera` instead of a struct whose
docblock happens to contain a `spawn_camera` snippet.

**5. Defaults are part of the answer.** Trait-impl methods from std traits are
dropped as boilerplate, but a type's *documented* `impl Default` - which often
states the actual default value, orientation or units - is captured onto the
type record and surfaced by `bevy_api`. `Type::default` resolves to the type
rather than to the unrelated free `default()` function. This is deliberate:
models guess defaults wrong, and a wrong default is as damaging as a wrong
signature.

Results are cached in `data/` and invalidated by a fingerprint of the input
directories, so startup is fast after the first run.

**6. Metadata supplements stay out of the index.** The feature graph,
default-plugin gates, error-code guides and panic-site provenance live in
`vendor/bevy-meta/`, and the plugin ↔ Bevy compatibility matrix in
`vendor/ecosystem/compat.json`. These are loaded on demand rather than baked
into the ~78 MB index bundle, so they can be corrected or re-harvested without
republishing every version. `bevy_check_manifest`, `bevy_explain_error` and
`bevy_perf_advisor` read them directly, and `bevy_ecosystem_compat` answers
from the vendored snapshot even offline.

**7. The system validator parses; it does not compile.** `bevy_validate_systems`
splits a signature with a bracket-stack parser, extracts each parameter's access
pattern and filters, and applies rules R1–R5. Filter disjointness is solved
properly (including tuple filters and `Or<…>`), so `Without<T>` legalises the
exact conflict it is meant to legalise. It is deliberately a linter for Bevy's
*access rules*, not a Rust type checker, and says so in its output.

Downloaded API records are reused when local website or example sources change.
The registry replaces their supplemental postings, merges richer duplicate API
rows, and validates required name, signature and documentation tokens before
accepting an unfamiliar search export. Missing or damaged search exports can be
rebuilt from valid API records without downloading rustdoc again. Persisted
corpus and search hashes let later loads import a trusted, unchanged text index
directly - skipping the per-record validation and containment scan - and retain
repaired postings without rewriting unchanged caches.

The first load builds two in-memory tables, both once per process: the
exact-symbol alias map (used by `bevy_api`) and a camelCase name-token index
(used to rank subject names during conceptual search). A warm load of the Bevy
0.20.0 corpus (252,761 records) takes roughly 16 seconds and searches return in
140–240 ms; most of the load is parsing `records.ndjson` and building those two
tables without per-record allocations. The corpus is memory-hungry, so run Node
with a raised heap limit (for example `--max-old-space-size=4096`); the heap
setting does not cap total process memory. Startup time varies with the corpus,
disk and machine.

---

## Repository layout

```
index.ts / server.ts          MCP server: resources, wiring, stdio transport
bin/bevy-mcp.ts               CLI: serve (default), fetch-index, fetch-docs, status
bevy-mcp.config.example.json  template config (copy to bevy-mcp.config.json)
server.json                   MCP registry manifest
PUBLISHING.md                 maintainer release checklist
vendor/bevy-website/          prose-only bevy-website (Book, guides, release notes)
vendor/bevy-meta/<version>/   harvested feature graph, plugin gates, error codes, panics
vendor/ecosystem/compat.json  plugin ↔ Bevy compatibility snapshot (from crates.io)
src/config.ts                 config-file + path + version resolution
src/store.ts                  index build, persisted search index, hybrid search, ranking
src/registry.ts               isolated indexes per version, persistence, corpus registry
src/types.ts                  record, configuration, metadata and query contracts
src/resources.ts              bevy:// URI scheme + templates
src/resources_impl.ts         resource read + completion handlers
src/pagination.ts             cursor pagination for list resources
src/versions.ts               crates.io lookup, stable-vs-prerelease split
src/format.ts                 response rendering (markdown + structuredContent)
src/tools/                    one module per MCP tool; src/tools/index.ts registers them all
src/analysis/features.ts      feature graph, transitive closure, path → subcrate/feature
src/analysis/rust-fn.ts       bracket-stack Rust signature parser
src/analysis/conflicts.ts     system access-rule rules R1–R5
src/analysis/filters.ts       Query filter parsing + disjointness solver
src/analysis/report.ts        system-validation rendering
src/analysis/compat.ts        caret-range satisfaction + vendored compat loader
src/ingest/rustdoc.ts         rustdoc HTML parser (one record per item)
src/ingest/markdown.ts        website markdown, heading chunking, classification
src/ingest/examples.ts        .rs example sources (engine + book)
src/ingest/owner.ts           impl-header parsing (owner type, trait)
scripts/fetch-docs.mts        docs.rs mirror with rate-limit handling
scripts/fetch-index.mts       download the prebuilt index from GitHub Releases
scripts/build-index.mts       build the index headlessly (CI / manual)
scripts/rebuild-all-indexes.mts rebuild existing mirrors sequentially, offline
scripts/publish-index.mts     package an index bundle for a Release
scripts/fetch-website.mts     refresh vendor/bevy-website (sparse, prose only)
scripts/harvest-meta.mts      harvest vendor/bevy-meta from the Bevy repo at a tag
scripts/harvest-compat.mts    harvest vendor/ecosystem/compat.json from crates.io
test/run-tests.mts            unit tests (uses real cargo doc output)
test/tools-test.mts           per-tool behaviour against a fixture index
test/resources-test.mts        resource conformance over a real MCP client
test/mcp-e2e.mts              protocol-level test over stdio
test/compat-test.mts          compatibility range + snapshot regression tests
test/meta-harvest-test.mts    vendored metadata shape and discoverability
```

`npm ci` builds the strict TypeScript sources into `build/`. The build also
generates compatibility launchers at `index.js`, `bin/bevy-mcp.js`, and the
previous `scripts/*.mjs` and `test/*.mjs` paths. These launchers are ignored by
Git. The legacy `scripts/rebuild-all-indexes.sh` path is also generated and
forwards to the compiled TypeScript maintenance command. Launchers are included
where needed in the distributable package. Existing MCP
client commands continue to work; the runtime needs Node.js 22 or newer.

---

## Run tests

```bash
npm test
npm run typecheck
BEVY_VERSION=0.20.0 BEVY_DOC_DIR=... node test/resources-test.mjs
```

`npm test` builds the TypeScript and runs every suite: unit/ingest/search,
qualified symbol lookup, duplicate-record merging, natural-language relevance,
per-tool behaviour (`test/tools-test.mts`, one suite per MCP tool), ecosystem
compatibility, vendored-metadata harvest, resource conformance, and the
protocol-level MCP end-to-end test. The per-tool suite runs in-process against a
deterministic fixture index plus the committed `vendor/bevy-meta`, so its
assertions do not depend on a locally built rustdoc tree.

`npm run test:package -- --git` also verifies an installed tarball and a Git
dependency prepared from TypeScript, using CLI and MCP checks outside the
checkout. It requires npm registry access to install their dependencies.
