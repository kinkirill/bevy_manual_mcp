# How it works

Back to the [README](README.md) · [Getting the API docs](GETTING-API-DOCS.md).

The server is a native Rust process with one job: answer from a corpus pinned to
the Bevy version in the user's `Cargo.lock`, without parsing JSON at startup.

## Pipeline

```
rustdoc HTML (docs.rs / cargo doc) ─┐
website markdown (Book, guides)    ─┤
engine examples                    ─┼─> records ──> interned arena ──> corpus.rkyv
error codes + feature metadata     ─┘                                    │
                                                                         ├─> symbol table
                                                                         ├─> name tokens
                                                                         └─> tantivy index
```

- **Records.** One record per rustdoc item: structs, fields, variants, methods,
  associated items, macros, plus website chunks and example files. Every record
  carries its source, kind, path, owner, crate, module, signature, docs and
  examples.
- **Archive.** `corpus.rkyv` stores all records, a single interned string arena,
  a dense-id ordering and the exact-symbol/name-token tables. It is loaded with
  `mmap` + `rkyv::access` and `bytecheck` on every load, so a truncated or
  corrupted file is rejected instead of read.
- **Text.** `tantivy/` stores ids and postings only; the payload lives once in
  the archive. A custom tokenizer splits camelCase and snake_case identifiers.
  Field boosts are `name > signature > docs`.
- **Search.** Exact symbol matches rank first, then name-token matches, then
  BM25 text hits. A ranking precision pass canonicalises query subjects and adds
  module/full-subject evidence, which is why `Events ECS event system` returns
  `bevy::ecs::event::Event` rather than `AssetEventSystems`.
- **Bundles.** A version's artifacts are packed as
  `bevy-<version>-fmt<format>.tar.zst` with a SHA-256 `index-manifest.json`.
  `fetch-index` verifies and installs atomically; the first server start can do
  this automatically.

## Why it is fast

The TypeScript line parsed 189 MB of NDJSON and imported a 120 MB FlexSearch
dump on every start (7–15 s per bundle). The Rust server mmaps a validated
archive (6–8 ms) and opens a 15 MB tantivy index; a query takes 22–30 ms,
including process start. A full rebuild from 8,665 rustdoc pages is ~30 s in
release mode and consumes about 125 MB + 15 MB on disk, versus 13–15 minutes and
a 2 GB heap for the old build.

Local rebuilds are therefore cheap enough to prefer over maintaining a repair
path: a damaged archive is rebuilt or re-downloaded, never migrated.

## Versions and metadata

- Version detection is file-based: `Cargo.lock` first, `Cargo.toml` second, then
  `BEVY_VERSION`.
- Each Bevy version has its own corpus directory. Only the active version is
  loaded eagerly; `bevy_api_diff` and `bevy://` reads open another version's
  archive on demand.
- Feature graphs, error-code guides and the plugin compatibility snapshot ship
  inside the bundle under `metadata/`. On a checkout, `vendor/bevy-meta` and
  `vendor/ecosystem` are the source of truth; installed bundle metadata takes
  precedence over them.

## Tools

The MCP surface is grouped by data source:

| group | tools |
|---|---|
| corpus search | `bevy_search`, `bevy_api`, `bevy_examples`, `bevy_migration` |
| version state | `bevy_index_status`, `bevy_indexed_versions`, `bevy_api_diff`, `bevy_check_version` |
| project/analysis | `bevy_check_manifest`, `bevy_validate_systems`, `bevy_explain_error`, `bevy_perf_advisor` |
| ecosystem | `bevy_ecosystem_search`, `bevy_ecosystem_compat`, `bevy_generate_plugin` |

Analysis tools are explicit about their limits: `bevy_validate_systems` is a
syntax-level linter (no type checking, B0001/B0002 are runtime panics);
`bevy_generate_plugin` is parsed with `syn` but `compile_verified` stays false;
`bevy_ecosystem_compat` uses a three-valued verdict and never turns an
unsupported requirement operator into "incompatible".

## Layout

```
src/main.rs          CLI dispatch: serve, build, fetch-index, search, harvest…
src/server.rs        MCP tools, resources and prompt-facing output
src/archive.rs       rkyv schema, builder, mmap loader
src/search.rs        hybrid ranking, filters, suggestions, migrations
src/text.rs          tantivy schema, tokenizer, index build/read
src/analysis/        features, systems, filters, conflicts, compat, errors, perf
src/ingest/          rustdoc HTML, website markdown, examples, metadata
src/harvest/         docs.rs, website, feature graph, compat harvesters
```

The design record, decisions and measurements are in
[docs/rust-rewrite.md](docs/rust-rewrite.md).
