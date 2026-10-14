# Tool contracts

This document is the maintained map from every registered MCP tool to the data
path it actually uses. It exists so that a tool's description, its handler and
its tests can be checked against the same contract, and so that a failure can be
attributed to one behavior rather than to "the server".

It is a living document: every PR in the enhancement plan updates the row(s) it
changes, and the **Description ↔ handler discrepancies** table records issues we
have confirmed but not yet fixed. A discrepancy is closed only when its
regression test stops being a `todo` and starts asserting the fixed behavior.

Tool descriptions are API contracts. If a description and a handler disagree,
the description is wrong unless a fix is in flight.

## Status legend

| Status | Meaning |
|---|---|
| **Verified** | Description matches the handler; a passing regression test exists. |
| **Discrepancy** | Description and handler disagree, or the handler is nonfunctional. Tracked in the table below. |
| **Partial** | The handler works but is narrower than advertised (documented limitation). |

## Shared result conventions

Tools should express provenance consistently. Today these fields are not applied
uniformly; the "expected" column is the contract the phase PRs converge on.

| Field | Meaning | Current state |
|---|---|---|
| `queried_version` | The version the caller asked for (may equal the project version). | `bevy_search` only |
| `project_version` | The version detected from the host project. | Not emitted directly; `bevy_index_status.bevy_version` |
| `indexed_version` / `version_indexed` | The version of the index that answered, and whether it was found. | `version_indexed` is a boolean on several tools |
| `source` / corpus id | The corpus or input that produced the answer. | Only `bevy_ecosystem_search.corpora_searched` |
| `corpora_searched` | The corpora a fan-out search actually visited. | `bevy_ecosystem_search` only |
| `analysis_complete` | Whether a linter analysed every construct, or stopped at a boundary. | Not emitted |
| `compatible` | Tri-state (`true`/`false`/`unknown`) compatibility verdict. | Boolean only |

`isError: true` is reserved for "I could not answer as asked" (no index, unknown
version, unknown template, no matches for a mandatory lookup). An empty result
from a best-effort search is not automatically an error, but must not read as a
successful exhaustive search.

## Tool contract matrix

Data sources are the code paths in `src/tools/*.ts` and their callees. "Version
behavior" states how the tool chooses an index.

| Tool | Purpose | Required inputs | Data source (actual) | Version behavior | Failure / partial states | Status |
|---|---|---|---|---|---|---|
| `bevy_search` | Hybrid search over API, book, migration guides, examples. | `query` (string) | Active `BevyIndex` via `hybridSearch` | Optional `version`; refuses unindexed versions | Unindexed version → error; no hits → empty success | Verified |
| `bevy_api` | Exact symbol → signature, docs, documented `Default`. | `symbol` | `index.lookupSymbol`, falls back to `hybridSearch(source=rustdoc)` | Optional `version`; refuses unindexed versions | Unknown symbol → error (or "related items" success) | Verified |
| `bevy_examples` | Runnable example source for a task. | `task` | `hybridSearch(kind=code_example)` on the active index | **No `version` input**; always the active index | No matches → error | Verified |
| `bevy_migration` | Breaking changes between two versions. | `to_version` or pinned version | `findMigrations` over website records in the active index | Compares doc metadata only; never loads another index | No target version → error; no notes → empty success | Verified |
| `bevy_api_diff` | Compare one symbol across named indexed versions. | `symbol`; `versions` when >2 indexed | `registry.get(version).lookupSymbol` per version | Explicit versions; refuses to substitute | <2 versions / unknown version / symbol absent → error | Verified |
| `bevy_check_version` | Is the index stale? Patch vs breaking. | none | `createVersionChecker` → crates.io (`/crates/bevy`), 6h cache | Compares against `config.bevyVersion` | Offline / HTTP failure → error | Verified |
| `bevy_indexed_versions` | Which versions can this server answer for? | none | `registry` manifest + active `index` | Lists registry entries | None | Verified |
| `bevy_index_status` | Self-diagnosis of the active index. | none | `formatStatus(index, config)` | Reports `bevy_version`, `doc_version`, `has_api_index` | None | Partial (distinguishes API vs prose via `has_api_index`) |
| `bevy_check_manifest` | Which Bevy features are enabled, and is a symbol/subcrate available? | optional `check` | `cargo metadata --offline --locked` when available, else `analyzeToml` + `vendor/bevy-meta/<ver>/features.json` | Pinned version only | No feature graph → error; Cargo unavailable → `partial: true` | Verified |
| `bevy_validate_systems` | Lint system signatures for access-rule panics. | `code` | `extractFnSignatures` + `parseQueryData` + `checkConflicts` | None; version is decorative | No `fn` found → error; unsupported constructs → `analysis_complete: false` | Verified (syntax-level linter, not a type checker) |
| `bevy_explain_error` | Explain a pasted Bevy panic/warning. | `message` | `vendor/bevy-meta/<ver>/error-codes/B####.md` | Pinned version only; rejects codes absent from it | Uncoded panic → tier-3 honest refusal | Verified |
| `bevy_ecosystem_search` | Search the Bevy index and every configured plugin corpus, labelled by crate. | `query` | `CorpusRegistry` loaded from `config.corpora` + the active `BevyIndex` | Pinned Bevy version; each plugin corpus carries its own crate version | No plugin corpora → Bevy-only with an explicit note; unknown crate → error; failed corpus → `failures` | Verified |
| `bevy_ecosystem_compat` | Plugin ↔ Bevy version compatibility. | optional `crate` | `vendor/ecosystem/compat.json` via `satisfiesRequirement` | Compares requirement strings to `config.bevyVersion` | Unknown crate → error | **Discrepancy C-07…C-12** |
| `bevy_generate_plugin` | Version-correct plugin scaffolds. | `template` | Hard-coded templates + `index.lookupSymbol` verification | Pinned version only; refuses when symbols missing | Unknown template → error | **Discrepancy C-13…C-15** |
| `bevy_perf_advisor` | Performance advice and anti-pattern detection. | optional `topic` / `code` | `vendor/bevy-meta/<ver>/perf.json` else built-ins | Pinned version only | Unknown topic → listed alternatives | Partial (no `perf.json` is currently vendored) |

### `bevy_perf_advisor` note

No `vendor/bevy-meta/<version>/perf.json` exists in the repository, so
`loadPerfTopics` always returns `[]` and the tool always serves the built-in
topics. The handler reports `source: "builtin"` honestly, but the title
("version-aware") and the description ("returns curated advice … version-correct")
overstate what is currently version-specific. The vendored `meta.json` also does
not record a `perf.json` input, so the absence is not surfaced as missing data.

## Description ↔ handler discrepancies

Each row is a confirmed review finding. "Regression test" is the test name in
`test/contract-regressions.mts`; a `todo` test states the **expected** behavior
and currently fails, so it is reported as `todo` instead of breaking CI. When a
fix lands, remove the `{ todo: … }` option and the test becomes a hard gate.

| ID | Tools | Finding (evidence) | Expected behavior | Regression test | Plan |
|---|---|---|---|---|---|
| C-01 | `bevy_ecosystem_search` | `registerAll` passed `pluginIndices: undefined`, so the tool always searched an empty map (`src/tools/index.ts`). The description also claimed it fanned out over Bevy, but the handler only iterated plugin indexes. | Load `config.corpora` through `CorpusRegistry`, include the primary Bevy index in the fan-out, and report `corpora_searched`, per-corpus provenance and load failures truthfully. | `ecosystem search: registerAll searches the configured plugin corpus` (hard gate from PR 2) and the `MCP ecosystem search reads a configured plugin corpus` end-to-end test | §5.1 |
| C-02a | `bevy_check_manifest` | `readEnabledFeatures` only copied an explicit `[dependencies].bevy.features` array; a bare `bevy = "0.20.0"` yielded no features, so implicit default features were reported as off. | A project that does not disable defaults reports the default feature set as enabled. | `manifest: implicit default features are reported enabled` (hard gate from Phase 1) | §5.2 |
| C-02b | `bevy_check_manifest` | `default-features = false` was not modelled at all; the result was indistinguishable from a default project. | `default_features_enabled: false` and only the explicitly requested features are on. | `manifest: default-features = false is represented` (hard gate) | §5.2 |
| C-02c | `bevy_check_manifest` | Dependency aliases (`alias = { package = "bevy", … }`) were ignored because only `deps.bevy` was read. | Features declared through an alias are attributed to Bevy. | `manifest: a package alias is resolved` (hard gate) | §5.2 |
| C-02d | `bevy_check_manifest` | The workspace branch iterated **all** `[workspace.dependencies]` entries, so a non-Bevy dependency's features leaked into the report, and it ignored `workspace = true` feature additions. | Only Bevy's inherited features are added, including those contributed by the workspace dependency. | `manifest: workspace inheritance does not leak other crates' features` (hard gate) | §5.2 |
| C-02e | `bevy_check_manifest` | Target-specific tables (`[target.'cfg(...)'.dependencies]`) were not read. | Target declarations are merged into the feature set. | `manifest: target-specific Bevy features are considered` (hard gate) | §5.2 |
| C-03a | `bevy_validate_systems` | `queryDataType` returned only the first `&Type` in a tuple, and `isMutableQuery` marked the whole expression mutable if any member was `&mut`. `Query<(&Transform, &mut Velocity)>` was therefore treated as a mutable `Transform`. | Each tuple member carries its own read/write mode. `Query<(&Transform, &mut Velocity)>` + `Query<&mut Transform>` is a **read/write (R1)** conflict on `Transform`; + `Query<&Transform>` is clean. | `validate: tuple member mutability is not leaked onto a read member` and `validate: tuple Query read of one member and read of another is clean` (hard gates) | §5.3 |
| C-03b | `bevy_validate_systems` | For the same reason, an overlapping `&mut Velocity` in another query was missed. | `Query<(&Transform, &mut Velocity)>` + `Query<&mut Velocity>` reports the `Velocity` overlap. | `validate: tuple Query detects a conflict on the mutable member` (hard gate) | §5.3 |
| C-04 | `bevy_validate_systems` | `extractFnItems` scanned for the literal substring `"fn"`, so comments and string literals created phantom systems. | Only real top-level `fn` items are analysed; the output says how many systems were checked. | `validate: fn inside a comment is not a phantom system` (hard gate) | §5.3.6 |
| C-05 | `bevy_validate_systems` | The result never distinguished "analysed and clean" from "could not parse". | `analysis_complete: false` and `unanalyzed` when a construct is outside the supported subset. | `validate: unsupported syntax is reported as not fully analyzed` (hard gate) | §5.3.4 |
| C-06 | `bevy_validate_systems` | The `context` input was accepted but never read, and the description promised "suggested fix from the pinned version's rustdoc" although no index lookup happened. | Removed from the schema, and the description no longer promises compilation or rustdoc-grounded fixes. | `validate: context input is not advertised` (hard gate) | §5.3.7–8 |
| C-07 | `bevy_ecosystem_compat` | `parseCaretRange("^0.0.3")` returns `max = 0.1.0`; Cargo treats `^0.0.3` as `>=0.0.3, <0.0.4` (`src/analysis/compat.ts:25`). | `^0.0.3` excludes `0.0.4`. | `compat: caret on 0.0.x does not span the minor line` (todo) | §5.4.1 |
| C-08 | `bevy_ecosystem_compat` | An unparsable requirement (`parseCaretRange → null`) becomes `satisfiesRequirement → false`, i.e. a definitive "incompatible". | Unsupported expressions yield `unknown`, never a negative verdict. | `compat: an unsupported requirement is unknown, not incompatible` (todo) | §5.4.1 |
| C-09 | `bevy_ecosystem_compat` | With no known Bevy version the handler sets `compatible = true` (`src/tools/ecosystem_compat.ts:53`). | No verdict when the Bevy version is unknown; never `compatible: true`. | `compat: an unknown Bevy version never yields compatible` (todo) | §5.4.4 |
| C-10 | `bevy_ecosystem_compat` | A match from any historical plugin release is collapsed into `compatible: true`; the matching versions are not returned. | Return the matching plugin versions as candidates, clearly labelled. | `compat: matching plugin versions are returned as candidates` (todo) | §5.4.2–3 |
| C-11 | `bevy_ecosystem_compat` | The warning path reads `entries[entries.length - 1]` on a newest-first list, so it quotes the oldest requirement (`src/tools/ecosystem_compat.ts:64`). | The message references the requirement of the release it names. | `compat: warning references the newest release's requirement` (todo) | §5.4.5 |
| C-12 | `bevy_ecosystem_compat` | The description promises "crates.io as a fallback"; no network lookup exists. The snapshot has no harvest date, source or completeness marker. | Implement a bounded fallback or remove the claim; add snapshot provenance. | `compat: the snapshot reports its provenance` (todo) | §5.4.6–7 |
| C-13 | `bevy_generate_plugin` | The SystemSet template emits `#[system_set]` (not a Bevy attribute) and references `OtherSystem`, which it never defines (`src/tools/generate_plugin.ts:45,51`). | Every template is self-contained; the SystemSet type derives `SystemSet` and no undefined type is referenced. | `generate: system-set template is self-contained` (todo) | §5.5.1 |
| C-14a | `bevy_generate_plugin` | The template shapes contain no `{{PLUGIN_NAME}}`/`{{RESOURCE_TYPE}}` placeholders at all, so `params` has no effect (`fillTemplate`). | Supported parameters change the emitted identifiers. | `generate: PLUGIN_NAME changes the emitted plugin` (todo) | §5.5.3–4 |
| C-14b | `bevy_generate_plugin` | `fillTemplate` builds a `RegExp` from the user-controlled key, so a key with regex metacharacters throws a `SyntaxError` (`src/tools/generate_plugin.ts:89`). | A bad key yields validation feedback, never a thrown `RegExp` error. | `generate: a malformed parameter key does not throw` (todo) | §5.5.4 |
| C-14c | `bevy_generate_plugin` | Unknown parameter keys are silently ignored with no record. | Unknown keys are rejected or echoed as ignored. | `generate: unknown parameters are reported` (todo) | §5.5.4 |
| C-15 | `bevy_generate_plugin` | `verifySymbols` checks name presence only and is presented as making the scaffold compile. | Symbol checks stay diagnostics; the description must not promise compilation. | `generate: symbol checks are labelled as diagnostics, not compilation` (todo); compile fixtures land in PR 6 | §5.5.1,6 |
| C-16 | `bevy_perf_advisor` | No `perf.json` is vendored, so "version-correct" advice is always built-in. | Surface the missing input; keep the description honest. | Documented limitation | §5.5 |
| C-17 | version policy | README describes same-minor index reuse while `VersionRegistry` is keyed by exact version. | One documented, centralized policy with explicit provenance. | Documented limitation (PR 7) | §6 |

## Fixtures

Phase 0 fixtures are committed, small and version-pinned; they do not depend on
the Bevy version active on the developer's machine.

| Fixture | Path | Purpose |
|---|---|---|
| Minimal project | `test/fixtures/projects/minimal/Cargo.toml` | A bare `bevy = "0.20.0"` dependency: implicit default features. |
| No-default project | `test/fixtures/projects/no-default-features/Cargo.toml` | `default-features = false` with one explicit feature. |
| Feature-rich workspace | `test/fixtures/projects/feature-rich/` | Workspace inheritance, dependency alias and a target-specific table. |
| Configured plugin corpus | `test/fixtures/ecosystem/bevy_egui/` | A corpus descriptor plus records, for the ecosystem-search contract. |
| Compatibility edge cases | `test/fixtures/ecosystem/compat-edge.json` | Unsupported requirement operators and a newest-first pair, for the compat contract. |

### Configured corpus shape (Phase 1)

`bevy-mcp.config.json` accepts a `corpora` array. Each entry is loaded once at
startup; a failure is recorded per corpus and surfaced by
`bevy_ecosystem_search` rather than preventing the server from starting.

| Field | Required | Meaning |
|---|---|---|
| `crate` | yes | Crate name, e.g. `bevy_egui`. |
| `version` | yes unless `auto` | Pinned crate version. `auto: true` resolves it from `Cargo.lock`/`Cargo.toml`. |
| `docDir` | one of `docDir`/`indexDir` | Rustdoc HTML tree (a docs.rs mirror or `cargo doc` output). |
| `indexDir` | one of `docDir`/`indexDir` | Directory holding a persisted `records.ndjson`; used when present, and written after a `docDir` build. |
| `source` | no | Provenance label shown in results, e.g. `docs.rs`. |

The deterministic in-memory index used by `test/contract-regressions.mts` is
built from `test/helpers.mts` (`fixtureRecord`) and a fixed `"0.20.0"` version,
so assertions do not depend on a locally built rustdoc tree or the pinned project
version.

## Baseline commands

Reproduce the contract baseline and the performance baseline:

```bash
npm ci
npm run typecheck
# Full suite, including the P0 contract regressions (todo = known failing).
npm test
# Just the contract regression file:
node build/test/contract-regressions.mjs
# Informational performance baseline (real index when installed, else synthetic):
npm run bench
```

`npm test` stays green while a discrepancy is open because its regression test
uses Node's `todo` option. `npm run bench` never fails the build on timing; it
prints a table and a JSON block and is documented in
[performance-baseline.md](performance-baseline.md).

See [`HOW-IT-WORKS.md`](../HOW-IT-WORKS.md#run-tests) for the rest of the suite
and [`README.md`](../README.md) for installation.

## Maintenance

1. Add or change a tool → update its row and, if behavior is user-visible, its
   description in the same PR.
2. Fix a discrepancy → remove its `todo` marker in
   `test/contract-regressions.mts`, confirm `npm test` passes, then mark the row
   **Verified** (or replace it with the new contract).
3. Add a limitation → add a row; do not leave an undocumented gap between a
   description and a handler.
