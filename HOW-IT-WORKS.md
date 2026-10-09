# How it works

Back to the [README](README.md).

```
bevy-website/content/**            ─┐
  book, migration guides, quick-start, FAQ
release-content/<ver>/**           ─┤
  per-PR migration notes, release notes
learning-code-examples/**/*.rs     ─┤
cargo target/doc/**/*.html         ─┼─> ingest ─> records ─> hybrid index
docs.rs mirror (optional)          ─┘                          │
bevy/examples/**/*.rs              ─┘                           ▼
                                                        FlexSearch (concepts)
                                  exact symbol table ──> (API symbols)
```

Five design decisions worth knowing:

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

---

## Repository layout

```
index.js                      MCP server: tools, resources, wiring, stdio transport
bin/bevy-mcp.js               CLI: serve (default), fetch-index, fetch-docs, status
bevy-mcp.config.example.json  template config (copy to bevy-mcp.config.json)
server.json                   MCP registry manifest
PUBLISHING.md                 maintainer release checklist
vendor/bevy-website/          prose-only bevy-website (Book, guides, release notes)
src/config.js                 config-file + path + version resolution
src/store.js                  index build, persisted search index, hybrid search, ranking
src/registry.js               per-version index persistence (fast reload)
src/multiversion.js           hold several versions in one process, scope searches
src/resources.js              bevy:// URI scheme + templates
src/resources_impl.js         resource read + completion handlers
src/pagination.js             cursor pagination for list resources
src/versions.js               crates.io lookup, stable-vs-prerelease split
src/format.js                 response rendering (markdown + structuredContent)
src/ingest/rustdoc.js         rustdoc HTML parser (one record per item)
src/ingest/markdown.js        website markdown, heading chunking, classification
src/ingest/examples.js        .rs example sources (engine + book)
src/ingest/owner.js           impl-header parsing (owner type, trait)
scripts/fetch-docs.mjs        docs.rs mirror with rate-limit handling
scripts/fetch-index.mjs       download the prebuilt index from GitHub Releases
scripts/build-index.mjs       build the index headlessly (CI / manual)
scripts/publish-index.mjs     package an index bundle for a Release
scripts/fetch-website.mjs     refresh vendor/bevy-website (sparse, prose only)
test/run-tests.mjs            unit tests (uses real cargo doc output)
test/resources-test.mjs       resource conformance over a real MCP client
test/mcp-e2e.mjs              protocol-level test over stdio
```

---

## Run tests

```bash
npm test
BEVY_VERSION=0.20.0 BEVY_DOC_DIR=... node test/resources-test.mjs
```
