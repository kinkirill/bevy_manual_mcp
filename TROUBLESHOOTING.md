# Troubleshooting

Back to the [README](README.md) · [Getting the API docs](GETTING-API-DOCS.md).

## The server says no Bevy version was detected

Version detection reads `Cargo.lock`, then `Cargo.toml`, starting at
`BEVY_PROJECT_ROOT` or the client's working directory. Set either:

```bash
export BEVY_PROJECT_ROOT=/path/to/your/game
# or
export BEVY_VERSION=0.20.0
```

`bevy-manual-mcp status` prints what was detected and from where.

## No corpus / first run did not download

- Check `BEVY_MCP_OFFLINE`; `1` disables auto-fetch and `fetch-index`.
- Run the install explicitly: `bevy-manual-mcp fetch-index 0.20.0`.
- A mirror can be used with `BEVY_MCP_INDEX_BASE_URL`.
- A failed download is logged to stderr but does not kill the server; tool calls
  then explain that no corpus is installed.

`bevy-manual-mcp status` shows the corpus path, record count and text-index state.

## A rebuilt tool still behaves like the old build

A running MCP server keeps its old executable mapped. After `cargo build`,
reconnect/restart the MCP client so it launches the new binary. The same applies
after replacing `vendor/ecosystem/compat.json`: an old binary that predates the
snapshot schema will report `invalid compat snapshot`.

## `bevy_check_version` fails or times out

The tool needs network access (crates.io sparse index, then the API). On a
blocked host it reports the failure instead of hanging. Set
`BEVY_MCP_OFFLINE=1` to suppress the check; everything else works offline.

## `bevy_api_diff` says a version has no compiled corpus

Only the active version is loaded eagerly. Other versions must be installed:
`bevy-manual-mcp fetch-index 0.19.1`. `bevy_indexed_versions` lists what can be
answered for.

## Feature checks say no feature graph is available

The graph ships in the bundle as `metadata/features.json`; on a checkout it is
read from `vendor/bevy-meta/<version>/features.json`. Run
`bevy-manual-mcp harvest-meta <version>` or set `BEVY_META_DIR`. A project that
does not depend on Bevy is reported as "Cargo.toml (no bevy dependency)", not as
a missing manifest.

## `bevy_ecosystem_compat` rejects the snapshot

Expects `{ "meta": …, "plugins": … }` (the legacy top-level map is still read).
Rebuild the binary if it predates the snapshot, and regenerate the snapshot with:

```bash
bevy-manual-mcp harvest-compat --out vendor/ecosystem
```

Unknown requirement operators deliberately produce `compatible: "unknown"`, not
an error.

## Plugin corpora are not searched

They live under `data/corpora/<crate>/<version>/` and need both `corpus.rkyv` and
`tantivy/`. Configure them in `bevy-mcp.config.json` (`corpora` array) or let the
server auto-discover the directory. `bevy_ecosystem_search` lists skipped corpora
with reasons.

## Rebuilds are slow

Use a release binary. Debug-mode rustdoc ingest is ~6 minutes; release is ~30 s
for the full 0.20.0 corpus. If you only have canonical NDJSON, `build --records`
skips HTML parsing entirely.

## Windows

The binary uses mmap and `std::fs` paths; tests run on Windows in CI. If a build
directory was copied from another machine, delete `target/` and rebuild. Index
bundles are platform-independent.
