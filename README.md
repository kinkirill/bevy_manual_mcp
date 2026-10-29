# bevy-manual-mcp

This MCP was designed by a human and built using AI tools to increase development
speed.

Bevy is a fast-moving project that changes with every release. Its documentation
is large and scattered, so finding an answer that actually matches *your* version
often means digging through rustdoc signatures, the Bevy Book, migration guides,
release notes and runnable examples - and still landing on something written for
a different release. This server tries its best to remove that friction.

You ask your agent a question and it answers from knowledge pinned to the exact
Bevy version your project is using.

Key points:

- MCP Registry name: `mcp-name: io.github.kinkirill/bevy-manual-mcp`

- **Native.** Rust, stdio MCP, no Node or npm in the user's path. (The initial
  version of this MCP was written in JS and later in TS.)
- **Small.** A 33 MB bundle per Bevy version (125 MB corpus + 15 MB tantivy
  index, zstd-compressed).
- **Fast.** ~10 ms cold start, 22–30 ms concept queries, sub-millisecond exact
  lookups.
- **Honest.** Every tool says what it cannot do: `bevy_validate_systems` is a
  syntax-level linter, compatibility can be `"unknown"`, and missing metadata is
  reported as missing.

## Install

```bash
cargo install bevy-manual-mcp
```

Requires a Rust toolchain. There is no prebuilt binary matrix and no npm shim.

The server starts answering immediately. If the detected Bevy version has no
installed index, it downloads the prebuilt bundle in the background (progress on
stderr) and reloads the index when the install completes. To install it
explicitly before starting the server:

```bash
bevy-manual-mcp fetch-index 0.20.1
bevy-manual-mcp status
```

Index releases are per Bevy **minor** (`v0.20`); an exact-patch corpus is used
when present, otherwise the same minor's newest corpus answers for the patch.
Status, search results and resources report both the project version and the
corpus version that actually supplied the data. `BEVY_MCP_OFFLINE=1` disables
all downloads, including the background fetch.

## Use it

The bare command is the MCP server (stdio), exactly as MCP clients launch it.

```bash
bevy-manual-mcp                 # serve MCP over stdio
bevy-manual-mcp serve           # explicit form
bevy-manual-mcp --help
bevy-manual-mcp status          # detected version, corpus state, paths
bevy-manual-mcp versions        # installed corpora
bevy-manual-mcp search "system ordering"
bevy-manual-mcp lookup Query::iter --json
```

### MCP client configuration

Most clients only need a command:

```json
{
  "mcpServers": {
    "bevy-manual-mcp": {
      "type": "stdio",
      "command": "bevy-manual-mcp",
      "env": {
        "BEVY_PROJECT_ROOT": "/path/to/your/bevy/game"
      }
    }
  }
}
```

`BEVY_PROJECT_ROOT` is optional if the client's working directory is the Cargo
project; the version is read from `Cargo.lock` first and `Cargo.toml` second.

## Tools

| tool | what it answers |
|---|---|
| `bevy_search` | Hybrid API + prose search: signatures, Book, guides, examples |
| `bevy_api` | Exact symbol lookup with the real signature, docs and related items |
| `bevy_examples` | Runnable engine/Book examples for a task |
| `bevy_migration` | Breaking changes between two Bevy versions |
| `bevy_api_diff` | One symbol across the compiled versions you name |
| `bevy_check_version` | Newest published Bevy, patch vs breaking, pre-releases |
| `bevy_indexed_versions` | Which Bevy versions this install can answer for |
| `bevy_index_status` | Self-diagnosis: active version, corpus, paths |
| `bevy_mcp_check_release_index` | Whether this server's GitHub index release has a newer corpus/revision |
| `bevy_check_manifest` | Enabled Cargo features and whether a symbol is available |
| `bevy_validate_systems` | Syntax-level B0001/B0002 lint (tuple-aware, filters) |
| `bevy_explain_error` | Explain a pasted panic/warning, version-checked |
| `bevy_ecosystem_search` | Fan-out over the Bevy corpus and installed plugin corpora |
| `bevy_ecosystem_compat` | Plugin ↔ Bevy compatibility from the vendored snapshot |
| `bevy_generate_plugin` | Self-contained plugin scaffold, parsed with `syn` |
| `bevy_perf_advisor` | Performance topics and `is_changed`/`is_added` detection |

`bevy_validate_systems` does **not** type-check and cannot decide Bevy runtime
panics; it recognises the B0001/B0002 access patterns and says when its analysis
is incomplete. `bevy_generate_plugin` reports `compile_verified: false` because
no compiler runs. `bevy_ecosystem_compat` is offline-only and returns
`compatible: "unknown"` for requirement operators it does not evaluate.

## Resources

The server also exposes `bevy://` resources and templates:

```
bevy://index/versions
bevy://api/<version>/<full::path>
bevy://kind/<version>/<kind>
bevy://module/<version>/<module>
bevy://crate/<version>/<subcrate>
bevy://owner/<version>/<Type>
bevy://doc/<version>/<rustdoc file>
```

Listings page at 50 items with query-bound cursors; reads open the requested
version on demand.

## Configuration

File (`bevy-mcp.config.json`), environment and defaults combine in that order;
environment variables win.

| variable | meaning |
|---|---|
| `BEVY_PROJECT_ROOT` | Cargo project used for version detection |
| `BEVY_VERSION` | Explicit version override, e.g. `0.20.0` |
| `BEVY_MCP_DATA_DIR` | Persistent corpus directory (default `~/.cache/bevy-mcp/data`) |
| `BEVY_MCP_OFFLINE` | `1` disables downloads |
| `BEVY_MCP_INDEX_BASE_URL` | Mirror for `fetch-index` releases |
| `BEVY_DOC_DIR` | Local rustdoc tree for `build --doc-dir` |
| `BEVY_WEBSITE_DIR` / `BEVY_EXAMPLES_DIR` | Local prose/examples sources for rebuilds |
| `BEVY_META_DIR` | Vendored `bevy-meta` root (feature graphs, error codes) |
| `BEVY_MCP_COMPAT_PATH` | Explicit `compat.json` path |
| `BEVY_MCP_MAX_RESULTS` | Default result count, 1–20 |
| `BEVY_MCP_DEBUG` | `1` for timing/progress diagnostics |

The config file additionally accepts a `corpora` array for plugin corpora:

```json
{
  "corpora": [
    { "crate": "bevy_egui", "version": "0.43.1" },
    { "crate": "bevy_rapier3d", "auto": true }
  ]
}
```

Plugin corpora live under `data/corpora/<crate>/<version>/` and are built with
the normal `build` command.

## Rebuilding indexes

```bash
# From a local `cargo doc` tree (or a docs.rs mirror)
bevy-manual-mcp build --doc-dir target/doc

# Canonical NDJSON input
bevy-manual-mcp build --records records.ndjson --out data/versions/0.20.0

# Release bundle + manifest
bevy-manual-mcp build --doc-dir ~/.cache/bevy-mcp/bevy-0.20.0 \
  --pack dist/bevy-0.20.0-fmt1.tar.zst \
  --manifest dist/index-manifest.json
```

A full 0.20.0 rebuild from 8,665 rustdoc pages takes ~30 s in release mode and
produces exactly the canonical corpus: 253,196 records, 653,264 symbol keys,
15.2 MB tantivy index. See [GETTING-API-DOCS.md](https://github.com/kinkirill/bevy_manual_mcp/blob/main/docs/GETTING-API-DOCS.md) and
[HOW-IT-WORKS.md](https://github.com/kinkirill/bevy_manual_mcp/blob/main/docs/HOW-IT-WORKS.md).

## Development

See [docs/DEVELOPING.md](https://github.com/kinkirill/bevy_manual_mcp/blob/main/docs/DEVELOPING.md)
for the layout, tests, index rebuilds and release process.

## License

MIT. Vendored Bevy metadata and website prose are covered in
[docs/THIRD-PARTY-NOTICES.md](https://github.com/kinkirill/bevy_manual_mcp/blob/main/docs/THIRD-PARTY-NOTICES.md).
