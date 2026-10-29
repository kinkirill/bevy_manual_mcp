# Cutover handoff

State at the pause before relocating. `main` is pushed; the cutover tree is local
and intentionally not merged yet.

## Branch state

| branch | commit | state |
|---|---|---|
| `main` | `5e6ea09` | pushed to `origin/main`; phase-0/phase-1 contracts + correctness work merged |
| `rust-rewrite` | `6b7ca6b` | Rust rewrite plus a merge of `main`; green, TypeScript still present |
| `cutover` | WIP checkpoint after `6b7ca6b` | **current branch**; TypeScript line deleted, metadata/auto-fetch added |
| tag `pre-cutover-oracle` | `5e6ea09` | local only; the TypeScript oracle snapshot |

`cutover` is **not pushed**. `main` is the safe, published history; do not force
anything over it.

## Done on `cutover`

- Deleted the TypeScript/Node line: `src/**/*.ts`, `test/`, `scripts/`,
  `package.json`, `package-lock.json`, `tsconfig.json`, `index.ts`, `server.ts`,
  `bin/`, `docs/performance-baseline.md`. Untracked `build/`, `dist/`,
  `node_modules/` were removed too.
- Rust-only tree passes: 124 tests (91 unit, 11 archive, 22 MCP), `clippy -D
  warnings` clean.
- Compat snapshot now uses the phase-1 `{ meta, plugins }` shape; the Rust loader
  also accepts the legacy top-level map. `compat-meta.json` is gone.
- Version metadata now travels inside bundles:
  `metadata/features.json`, `metadata/error-codes/`, `metadata/compat.json` are
  copied at build, packed with the bundle, installed with `fetch-index`, and
  preferred by the feature/error/perf/compat resolvers.
- First-run auto-fetch: server startup downloads the bundle when the corpus is
  missing and `BEVY_MCP_OFFLINE` is not set. Verified manually against a local
  `file://` release; search, `bevy_check_manifest` and `bevy_explain_error`
  worked from the fetched metadata with an empty `vendor/bevy-meta`.
- `build --pack <asset> --manifest <file> [--revision N]` now emits the
  `index-manifest.json` v2 that `fetch-index` consumes.
- Rewritten for Rust: `README.md`, `GETTING-API-DOCS.md`.

This WIP commit is a checkpoint, not a release: several docs and workflows still
describe the TypeScript line.

## Remaining before merging `cutover` into `main`

1. Run the remaining parity gate from the oracle snapshot:
   - `git worktree add /tmp/bevy-oracle pre-cutover-oracle`, `npm ci`, then the
     TypeScript unit/contract suites (the TS-specific e2e/resources harness
     launches the Node server directly and needs an adapter to target Rust; the
     Rust MCP suite now covers the same stdio/resources surfaces).
   - Compare corpus questions and the ranking snapshot; review any ranking diff.
   - The 15-tool field report on 0.20.0 is 13/15 with two known environmental
     limitations (network version check; cross-version diff needs another
     corpus). `bevy_ecosystem_compat` failure was a stale running binary.
2. Clean-install gate: already passing via the
   `clean_install_auto_fetches_the_bundle_and_its_metadata` MCP test and a
   manual `cargo install --path .` run.
3. Merge `cutover` into `main` (no-ff), push, then finish the release:
   - publish `bevy-manual-mcp` 0.1.0 only after the gate;
   - build/upload six bundles (0.15.3, 0.16.1, 0.17.3, 0.18.1, 0.19.1, 0.20.0)
     plus their manifests;
   - publish the MCP registry entry.

## Verification commands

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo package --list
```

Manual auto-fetch check (already passed once):

```bash
# local bundle + manifest, fresh data dir, BEVY_MCP_OFFLINE=0
# server logs "installed the index for Bevy …"; search then works
```

## Environment notes

- `data/` and `target/` are git-ignored. A relocated checkout needs
  `bevy-manual-mcp fetch-index` again unless `data/` is moved with it.
- `vendor/bevy-meta` and `vendor/ecosystem` are tracked source metadata.
- The release workflows currently in the tree are the old Node versions; do not
  trigger them on `cutover`.
