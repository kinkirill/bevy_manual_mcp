# Rust rewrite — shared design

Status: **agreed design, not yet implemented.** This document records the outcome
of a design interview. It is the contract for the port; code that disagrees with
it is wrong, and a disagreement with it is a decision to be recorded here first.

Branch: `rust-rewrite`, created directly off `origin/main`. `main` is frozen at
bug-fix-only for the duration of the port.

The pending Phase 0/1 correctness work and `docs/tool-contracts.md` are not on
`main` yet; they live on the unmerged Phase 0/1 branches. The parity gate in
§13 depends on that work, so it must reach `main` before cutover. Until then the
port runs against the published TS line and the gate is assembled at the end.

## 1. Why

The current server is TypeScript. Its measured cost on the 0.20.0 corpus
(252,761 records, 653,264 symbols):

| measurement | value | note |
|---|---:|---|
| `records.ndjson` | 189 MB | one JSON object per line |
| FlexSearch dump (`text-index.json`) | 120 MB | opaque, machine-only |
| cold start | **16.5 s** | parse + build symbol/name tables + import postings |
| runner advice | `--max-old-space-size=4096` | the corpus is heap-hungry |
| concept search | 117–257 ms | |
| exact lookup | <1 ms | already fine |
| all six version caches | 1.5 GB | 73–120 MB text + 107–189 MB records each |

Most of that is **JSON parsing**, not I/O. The record text is also redundant:
27.3 MB of `docs` collapses to 21,412 unique strings (~23 MB duplicated), and
examples add 44 MB. Node in the install path (`npm install -g --allow-git=...`)
adds toolchain friction on top.

## 2. Goals and success criteria

Primary axes, in the order they were chosen:

1. **Cold start and memory.** Native process, zero parse at startup.
2. **Install path.** `cargo install bevy-mcp`; no Node, no npm, anywhere in the
   user's path.
3. **The analyzer parses properly.** `syn` replaces the hand-rolled
   bracket-stack signature parser.
4. **Memory footprint across six corpora.** mmap lazily; files are not
   resident just because they exist.

Concept-query latency is explicitly *secondary* to ranking quality. Targets:

| metric | target |
|---|---|
| cold start (0.20.0 corpus, one version) | **≤ 250 ms** |
| resident memory, one active corpus | **≤ 400 MB** |
| concept query | **≤ 30 ms** |
| exact symbol lookup | **< 1 ms** |
| bundle size per version | **≤ 150 MB** |
| tantivy index open | **≤ 75 ms** (spike gate) |
| tantivy index on disk | **≤ 250 MB** (spike gate) |

## 3. Non-goals

- No embeddings model and no network LLM in the search path. Offline, stdio-only
  remains the contract.
- No curated synonym thesaurus in v1 (see §9).
- No prebuilt binary matrix, no `cargo-binstall`, no npm shim.
- No archive migration code (see §7).
- No columnar record layout in v1.
- No rustdoc-JSON ingest path in v1.
- No compile-level verification in `bevy_validate_systems` in v1.

## 4. Distribution and identity

- **One published package:** `bevy-mcp` on crates.io. It is currently free
  (sparse-index 404 for both `bevy-mcp` and `bevy_mcp`). crates.io treats names
  differing only by case or `-`/`_` as taken, so publishing this name also locks
  out `bevy_mcp`. Lowercase, hyphenated: command `bevy-mcp`, library name
  `bevy_mcp` (derived by Cargo) if a lib target ever exists.
- **Install:** `cargo install bevy-mcp`. Source-only; the user is expected to
  have a Rust toolchain. CI still verifies the crate builds on Linux, macOS and
  Windows.
- **First publish only at parity**, as **0.1.0**. No preview releases and no
  placeholder/`0.0.1` reservation: a half-baked artifact is exactly what we are
  refusing to ship. A crate version no longer tracks a Bevy version; the binary
  reports its own version and the indexes it can serve.
- **Index bundles** stay on GitHub Releases. Nothing new to host.
- **MCP registry:** `server.json` moves to `registryType: "cargo"`,
  `identifier: "bevy-mcp"`, stdio transport, same environment variables. The
  registry schema permits `cargo` and does not require `packages`, so the entry
  stays honest. Publish the entry only once the crate is actually installable.
- **Index acquisition:** first run auto-downloads the bundle for the detected
  Bevy version (progress on stderr, clear failure message); `BEVY_MCP_OFFLINE=1`
  opts out. The index cannot be embedded in the crate: crates.io enforces a
  per-version upload limit on the order of 10 MB, and embedding six ~150 MB
  corpora would mean republishing the crate on every index rebuild.

## 5. CLI contract

The bare command is the MCP server. MCP clients launch `bevy-mcp` with no
arguments, and every existing config depends on that.

```
bevy-mcp                 # serve on stdio (bare = serve)
bevy-mcp serve           # explicit form
bevy-mcp --help | help   # manual
bevy-mcp --version       # crate version + servable index versions
bevy-mcp status          # detected Bevy version, config, bundle state
bevy-mcp fetch-index [ver]
bevy-mcp build [--doc-dir …] [--out …]
bevy-mcp search "query" [--json] [--limit N] [--kind …]
bevy-mcp lookup Symbol [--json]
bevy-mcp explain "query" [--json]   # score breakdown
bevy-mcp versions                   # installed/available corpora
```

When stdin is a terminal, bare `bevy-mcp` prints a one-line notice to **stderr**
("serving MCP over stdio — Ctrl-C to exit; see --help") and then serves. Stdout
stays clean for the protocol, so nothing breaks.

`search`, `lookup`, `explain` and `versions` are permanent features (useful to
humans and to maintainers), not test scaffolding. The parity gate still goes
through MCP, not through these verbs (§13).

## 6. Package layout

**One package**, not a published multi-crate workspace: a published crate may
not depend on an unpublished path crate, so three crates would mean three
crates.io names to own and publish in lockstep. Modules are the internal seam;
subcommands are the entry points.

```
Cargo.toml                 package bevy-mcp, version 0.1.0 at parity
src/main.rs                clap dispatch: serve | build | fetch-index | search | …
src/config.rs              config file, env precedence, data dirs
src/version_detect.rs      Cargo.lock parse (fast path), Cargo.toml fallback
src/records.rs             record types, NDJSON parse/serialize, interning
src/archive.rs             rkyv layout, write, mmap + bytecheck load
src/bundle.rs              bundle manifest, download, verify, atomic unpack
src/search/
  symbol.rs                exact-symbol alias table (built at build time)
  names.rs                 camelCase name-token index
  text.rs                  tantivy schema, tokenizer, query, merge
  rank.rs                  hybrid merge and scoring
  related.rs               PMI table, suggestions, low-yield expansion
src/tools/                 one module per MCP tool
src/analysis/              features, syn-based fn parsing, conflicts, filters, compat
src/ingest/                rustdoc HTML, markdown, examples (builder-side)
src/builder/               NDJSON → archive + tantivy → bundle
tests/                     Rust integration tests (spawn the binary, speak MCP)
```

The forward-looking types (`Query<'_, '_, &T>` normalisation, owner/trait
parsing) are carried over from the TS implementation and ported 1:1 before
anything is "improved".

## 7. Data and bundle format

**Two layers, one identity.**

- **NDJSON stays canonical.** It is diffable, repairable, testable, and
  rebuildable from rustdoc; the existing duplicate-merge and registry-repair
  logic keeps operating on it. It is a maintainer/build artifact and is *not*
  shipped in bundles.
- **The archive is derived.** A version becomes a bundle:

```
bevy-<bevy_version>-fmt<format_version>.tar.zst
  corpus.rkyv        records, interned string arena, symbol table,
                     name-token index, relatedness table, metadata
  tantivy/           text index; stores record ids only, no payload copy
  meta.json          bevy version, crate versions, source fingerprints, built_at
```

- **The split:** tantivy stores *ids and postings only*; every byte of payload
  (docs, signatures, examples, owners, paths) lives once in `corpus.rkyv`. Ids
  are dense `u32`s assigned by the builder; the readable string id is retained
  in rkyv for output.
- **Interning:** all strings go through one arena (docs dedupe alone saves
  ~23 MB). No compression inside `corpus.rkyv` — it would destroy zero-copy.
  The `.tar.zst` container is where compression lives.
- **Loading:** mmap + `rkyv::access` **with `bytecheck` on every load**. No
  `access_unchecked` on a downloaded file. rkyv is pinned exactly (0.8.x);
  tantivy is pinned exactly (0.27.x).
- **Evolution:** `format_version` covers the rkyv schema *and* the tantivy
  side (an id table that does not resolve is a corrupted corpus). A mismatch is
  never migrated: rebuild from local sources if they exist, otherwise
  re-download. Old cache files are ignored and cleaned.
- **Atomic install:** download to `.tmp`, verify SHA-256 against the release
  manifest, unpack, then rename into `data/versions/<bevy_version>/`. A partial
  file must never be mmap-able.
- **Precedence:** local `BEVY_DOC_DIR` sources win over a downloaded bundle;
  download happens only when neither a valid local build nor a valid bundle
  exists.

## 8. Search pipeline

1. **Exact symbol table** (rkyv): qualified names and aliases, generics and
   whitespace stripped, `Type::default` resolving to the type. Answers
   `bevy_api`; always ranks first when it hits.
2. **Name-token index** (rkyv): camelCase/snake_case pieces → record ids. Keeps
   subject names above prose matches, as today.
3. **tantivy** over `name`, `signature`, `docs`, with a custom tokenizer that
   splits camelCase and keeps snake_case parts, and field boosts
   `name > signature > docs`. Handles BM25, phrases, and Levenshtein typo
   tolerance.
4. **Hybrid merge** (`rank.rs`) preserves the current ordering semantics and is
   calibrated against the corpus harness — not rewritten from scratch.

Tantivy is accepted **behind a spike gate**: open ≤ 75 ms, query ≤ 30 ms, index
≤ 250 MB. If the spike misses, the fallback is a bespoke inverted index inside
`corpus.rkyv` (the original one-file design), recorded here as a decision
change.

## 9. Semantics: related terms, not a thesaurus

No hand-curated synonym file in v1. The reason is version scoping: a static
`event → message` is right for 0.17+, wrong for 0.16, and a global JSON file
cannot express that. The corpus can: migration guides discuss renames in the
version where they happened.

- The builder derives a **PMI / co-occurrence** table per corpus (docs,
  examples, Book), stored in `corpus.rkyv` as token-id → top-k neighbours.
- It is surfaced as `related_terms` in `structuredContent` alongside hits, and
  used for query expansion **only when lexical yield is low**. It never
  silently rewrites a strong query.
- Gate: A/B on the existing 15 ranking queries plus synonym cases (`ball`,
  `fps`, `gui`, `health bar`, `velocity`). Ship only if synonym top-3 improves
  **without regressing** the 15. If the A/B fails, disable the semantic layer
  entirely (fallback = pure lexical + typo fuzzy). A curated override file is
  allowed later only with a failing case to point at.

Tantivy's fuzzy matching solves typos (`spher`), not semantics (`ball`); the two
are not interchangeable.

## 10. Config, version detection, manifests

- Config file (`bevy-mcp.config.json`), environment variables
  (`BEVY_PROJECT_ROOT`, `BEVY_VERSION`, `BEVY_DOC_DIR`, `BEVY_MCP_DATA_DIR`,
  `BEVY_MCP_OFFLINE`) and precedence stay unchanged.
- **Version detection stays file-based** (Cargo.lock first, Cargo.toml
  fallback): it answers one question in microseconds and must not cost a
  subprocess on every start.
- **`bevy_check_manifest` calls `cargo metadata --offline --locked`**, with the
  built-in parser as fallback when cargo is absent. This is where manifest
  semantics belong, and it fixes the C-02 family (implicit default features,
  `default-features = false`, aliases, workspace inheritance, target-specific
  tables) properly.
- `bevy_validate_systems` parses with `syn`: real `fn` items, per-member
  mutability in tuple queries, filters, and an honest `analysis_complete:
  false` for unsupported constructs. It remains a **syntax-level linter**. It
  does not type-check, and it cannot decide B0001/B0002 — those are Bevy
  *runtime* panics, not compile errors. No compiler, `syn` included, can rule
  on them without resolving types.
- `bevy_generate_plugin` runs generated code through `syn` and rejects
  unparsable output; `compile_verified` stays `false` unless a real compile ran.
  A `cargo check` subprocess mode is deferred out of v1.

## 11. Port order

Walking skeleton first; every step lands with its tests and a green CI, not
"tests at the end".

| step | content | gate |
|---|---|---|
| 0 | package skeleton, CLI contract, `rmcp` stdio, `status` + `indexed_versions` from `meta.json` | `cargo test`; bare command serves; `--help` works; `mcp-e2e` handshake |
| 1 | `ndjson → corpus.rkyv` converter, bundle download/verify/unpack, mmap loader | archive round-trips; `bytecheck` rejects corruption; cold start measured |
| 2 | symbol table, name tokens, tantivy build/read, `bevy_api` + `bevy_search` | exact-symbol suites; corpus questions; ranking snapshot reviewed |
| 3 | resources/templates/completions/pagination; `examples`, `migration`, `api_diff`, `check_version` | `resources-test`; tool-contract rows |
| 4 | `check_manifest` (cargo metadata), `validate_systems` (syn), `perf_advisor` | C-02 regressions; validate hard gates; no phantom `fn` |
| 5 | `ecosystem_search`/`ecosystem_compat`, `generate_plugin`, `explain_error` | contract regressions; offline compat |
| 6 | full ingest (rustdoc HTML, markdown, examples), builder/publish/fetch, harvesters | local rebuild from `BEVY_DOC_DIR`; scripts ported |
| 7 | cutover and release | full parity gate; TS deleted; `0.1.0` published |

## 12. Repository and Node

- Work happens on `rust-rewrite`, not a fork. A fork buys a separate issue
  surface and costs unrelated history, duplicated CI, and split bug tracking. A
  branch from `main` is isolated the same way and merges cleanly.
- **`main` is frozen**: bug fixes only, no new features, for the duration.
- Node is allowed **in CI/dev until cutover**, because the parity oracle is the
  existing TypeScript harness. It is not a user dependency.
- By the cutover commit, all `scripts/*.mts` (including `fetch-docs`,
  `fetch-website`, `harvest-meta`, `harvest-compat`) are ported, the TS sources
  and harness are deleted, and `grep -r node .` finds only prose.

## 13. Testing and the parity gate

- Rust unit tests for parsing, scoring, interning, filtering, conflicts.
- Rust integration tests spawn the binary and speak MCP over stdio.
- The existing TS suites keep running against **both** implementations during
  the port; they are the oracle.
- Gate definition (all must hold):
  - every row in `docs/tool-contracts.md` verified (the contract file arrives
    with the pending Phase 0/1 work; see the header note);
  - corpus questions + reviewed ranking snapshot green (ranking changes may be
    accepted, but as a reviewed diff — never a mass snapshot update);
  - `mcp-e2e` and `resources-test` green against the Rust binary;
  - clean-machine `cargo install` → auto-fetch → first query works;
  - performance targets in §2 met.

## 14. CI and release

- `cargo fmt --check`, `clippy -D warnings`, `cargo test` on Linux, macOS and
  Windows.
- A job runs the TS oracle harness (Node) until cutover.
- A release job builds one bundle per Bevy version, writes `manifest.json`
  (`format_version`, `sha256`, `size`, `built_at`, `bevy_version`), and uploads
  to GitHub Releases.
- No cross-compiled binaries, no installers.

## 15. Risks

| risk | mitigation |
|---|---|
| tantivy spike misses | bespoke index fallback; archive design already supports it |
| ranking regression | harness + reviewed snapshots; port merge logic before tuning |
| PMI noise hurts precision | low-yield-only expansion, A/B gate, disable on regression |
| tantivy/rkyv format drift | exact pins, `format_version`, fail-and-rebuild |
| custom tokenizer bugs | tokenizer unit tests on Rust identifiers before indexing |
| bundle size grows | interning, ids-only tantivy, measured against ≤150 MB |
| crates.io name squat | small; no placeholder publish by decision |
| Windows path/mmap behaviour | CI on Windows from step 0 |

## 16. Decision log

| # | decision | chosen | rejected / note |
|---|---|---|---|
| 1 | primary axes | cold start + memory, install path, parser, multi-corpus RSS | search latency demoted behind ranking quality |
| 2 | runtime shape | full native binary | Rust core + TS shell; TS-only reader |
| 3 | repo topology | branch `rust-rewrite`, `main` frozen | fork (merge debt, split issues) |
| 4 | package layout | one package, subcommands | 3 published crates (crates.io path-dep rule) |
| 5 | MCP stack | `rmcp` 3.8, stdio features only, pinned | hand-rolled JSON-RPC |
| 6 | records storage | rkyv 0.8, structs + interned arena, dense u32 ids | columnar (later, measured) |
| 7 | text storage | tantivy 0.27, ids only, payload in rkyv | FlexSearch port; bespoke postings |
| 8 | canonical artifact | NDJSON canonical, bundle derived | rkyv as source of truth |
| 9 | loading safety | `bytecheck` on every load | `access_unchecked` + checksum |
| 10 | evolution | fail loudly, rebuild or re-download | migration code |
| 11 | index delivery | auto-fetch on first run, per-version `.tar.zst` | 6-version mega-bundle; embedded index |
| 12 | install | `cargo install` only, source-only | prebuilt matrix, binstall, npm shim |
| 13 | registry | `registryType: "cargo"`, publish at parity | npm entry, OCI image |
| 14 | versioning | 0.1.0 at parity, decoupled from Bevy | Bevy-aligned 0.20.x; preview/placeholder |
| 15 | CLI | bare = serve; `--help`; verbs for search/lookup/explain | bare = help; TTY magic |
| 16 | semantics | corpus-derived PMI, `related_terms`, low-yield expansion | curated thesaurus; embeddings; LLM |
| 17 | version detection | lockfile parse; `cargo metadata` only for manifest tool | cargo metadata everywhere |
| 18 | analyzer | `syn` parsing only; no type/compile claims | syn as a validator; compile subprocess in v1 |
| 19 | Node | CI/dev until cutover, then gone | Node-free during the port |
| 20 | test strategy | Rust tests + black-box MCP gate + TS oracle | two-state harness; port tests first |

## 17. Deliberately still open (implementation, not architecture)

- exact rkyv struct field set and arena layout;
- tantivy schema constants, boost values, merge parameters;
- exact `manifest.json` field names and bundle compression level;
- the "low lexical yield" threshold and `related_terms` token budget;
- per-step checklists inside each port step;
- CI workflow files.

## 18. Step 1 results — measured

The archive pipeline is real enough to answer the question this port was
started for. Measured on the Bevy 0.20.0 corpus on Linux x64, release build,
same machine, same operation (`App::add_systems`, 3 hits in both):

| measurement | TypeScript (measured) | Rust + rkyv (measured) |
|---|---:|---:|
| time to answer from process start | **7,465 ms** | **7.6–11.1 ms** |
| peak RSS | **1,195 MB** | **50 MB** |
| corpus file on disk | 189 MB NDJSON + 120 MB FlexSearch dump | **112.9 MB** `corpus.rkyv` |
| validated load (`bytecheck`, 113 MB) | n/a (JSON parse is the load) | **5–7 ms** |
| exact symbol keys | 653,264 | **653,264 (exact match)** |
| build time from NDJSON | n/a (parsed at every start) | 4.8 s, one-off |

The TypeScript number is the documented 16.5 s cold-start baseline's warm-cache
counterpart (7.5 s with the page cache populated); the Rust number was also
measured after `posix_fadvise(DONTNEED)`, so it is not relying on the
just-written file being hot. The archive was built from `records.ndjson`,
which contains the 249,353 rustdoc records; the TypeScript index additionally
merges 3,389 Book/guide records, 13 learning examples and 6 metadata records
at load time (252,761 total). Those arrive with the ingest step (§11 step 6),
not with the archive format.

Consequences recorded:

- The `rkyv` schema (records + interned arena + symbol table + name-token
  index) is settled as implemented; `format_version` is `1`.
- `bevy-mcp build --records <ndjson> --out <dir>` is the builder entry point
  until source ingest lands; it writes `corpus.rkyv` plus
  `corpus.manifest.json` (size, SHA-256, counts) atomically.
- Bundle `.tar.zst` packing and `fetch-index` download are deferred to step 2,
  when the bundle has its final contents (tantivy). The manifest contract is
  already written and tested; only the container and transport are missing.
- `bevy-mcp lookup <symbol>` now goes through the mmap, so the CLI debugging
  surface from §5 is live rather than stubbed.
