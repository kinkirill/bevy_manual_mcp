# Step 4 handoff

State at the pause point. Read alongside [`rust-rewrite.md`](rust-rewrite.md).

## Repo state

- Branch: `rust-rewrite`, base `origin/main`, plus the rewrite commits.
- HEAD: `d4b278b` (all committed work builds; 49 tests: 28 unit, 10 archive,
  11 MCP).
- Working tree: `src/features.rs` is untracked/in-flight (see below).
- Package: `bevy-manual-mcp` **0.1.0**, binary `bevy-mcp`, unpublished.
  `bevy-manual-mcp` **0.0.1** is reserved and live on crates.io (lib-only).
- MCP config: `~/.pi/agent/mcp.json` → `bevy-rust` runs
  `target/release/bevy-mcp` with `BEVY_VERSION=0.20.0`, no proxy pinned.
  Restart/reconnect after each rebuild — a running server keeps its old binary
  and old env mapped.
- Corpus: `data/versions/0.20.0/` (gitignored) has the full 253,196-record
  corpus (448 examples, engine examples resolved from
  `$CARGO_HOME/registry/src/*/bevy-0.20.0/examples`), 125 MB archive,
  15.2 MB tantivy index.

## Done

Steps 0–3 of the plan:

- CLI + stdio MCP (`rmcp`), config/version detection, `status`/`versions`.
- rkyv archive (records, interned arena, symbols, name tokens), bytecheck load,
  `lookup`, full ingest (rustdoc NDJSON, website, examples, error codes).
- Tantivy text index, hybrid search, `bevy_search`/`bevy_api`, ranking
  precision pass, near-miss suggestions from prose.
- Bundle packing + `fetch-index` (32.4 MB bundle, verified install).
- Tools: `bevy_examples`, `bevy_migration`, `bevy_api_diff`,
  `bevy_check_version`.
- Resources: `bevy://index/versions`, templates for api/kind/module/crate/
  owner/doc, completions, pagination (50/page, query-bound cursors).

## In flight

`src/features.rs` — complete feature-graph module (not wired):

- loads `vendor/bevy-meta/<version>/features.json` (features, closure,
  default_features, plugin_gates);
- `enabled(project_root, data)` uses `cargo metadata --offline --locked`
  when it resolves, otherwise a Cargo.toml parser that handles aliases,
  workspace inheritance, target tables and `default-features = false`;
- `check(query, data, transitive)` resolves features, `bevy_` prefixes,
  `bevy::<module>` subcrates and plugin gates;
- unit tests cover fallback parsing, inheritance and checks.

It is **not** declared as a module yet, so the build ignores it.

## Next actions (step 4)

1. `mod features;` in `src/main.rs`; add MCP tool `bevy_check_manifest`
   (`check: Option<String>`) that loads the graph, calls
   `features::enabled` + `features::check`, and renders the TS-shaped report
   (full table + plugin gates; structured `explicit`/`transitive`/`disabled`/
   `no_manifest`).
2. Add `bevy_perf_advisor` (`topic`, `code`, `limit`). Vendored
   `perf.json` does not exist; port the three built-in topics
   (`change-detection`, `archetypes`, `scheduling`) and the
   `is_changed`/`is_added` anti-pattern detection from
   `src/tools/perf_advisor.ts`. Say `source: "builtin"` honestly.
3. Add `bevy_validate_systems` with `syn` (the actual step-4 flagship):
   `syn = { version = "2", features = ["full", "parsing"] }`.
   Port the *semantics* of `src/analysis/rust-fn.ts`, `filters.ts`,
   `conflicts.ts`, `report.ts`:
   - parse files (top-level `Item::Fn`; comments/strings must not create
     phantom `fn`s — the old bracket parser's C-04 bug);
   - per-system access: `Query<...>` members with independent `&T`/`&mut T`
     (tuple-aware), `Res`/`ResMut`, `ParamSet`, filters
     (`With`, `Without`, `Or`, tuples; do not treat filter-only types as
     accesses);
   - rules R1–R5, B0001/B0002 labels, `analysis_complete: false` for
     unsupported constructs;
   - never claim type checking; B0001/B0002 are runtime panics.
4. Tests: MCP fixture with a fake `vendor/bevy-meta/9.9.9/features.json` and a
   Cargo.toml project (cargo metadata fails without `src/`, exercising the
   fallback); validate tests for tuple mutability, filters, phantom `fn` in a
   comment, and unsupported syntax.

## Environment notes

- `crates.io:443` is blocked from this machine; `index.crates.io`,
  `static.crates.io` and GitHub raw work. `bevy_check_version` reads the
  sparse index first for this reason. A local proxy exists at
  `127.0.0.1:2080` (ThroneCore); only needed for the crates.io API fallback.
- Publishing: `cargo publish` works through
  `HTTPS_PROXY=http://127.0.0.1:2080` with a verified crates.io email.
  Do not publish 0.1.0 before parity.
- `cargo package` must stay small: the `include` list is
  `/Cargo.toml`, `/Cargo.lock`, `/README.md`, `/LICENSE`,
  `/docs/rust-rewrite.md`, `src/**/*.rs` (22 files, ~85 KB compressed).
