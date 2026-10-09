# Troubleshooting

Back to the [README](README.md).

---

## "Records: 0", or no API results at all

The rustdoc half of the index is empty. Either install a prebuilt index:

```bash
bevy-mcp fetch-index 0.20.0
```

or build one from a mirror of your own (see
[GETTING-API-DOCS.md](GETTING-API-DOCS.md)), then call `bevy_index_status` to
confirm what is loaded. `bevy_index_status` reports the record count, the
per-source breakdown and the paths it resolved, which is the fastest way to see
*which* half is missing.

## "Bevy version: UNKNOWN"

The server could not work out which version to answer for, which defeats the
whole point, so it says so loudly. Fix it with any one of:

- set `BEVY_VERSION` (e.g. `0.20.0`), or
- set `BEVY_PROJECT_ROOT` to a Cargo project with a `Cargo.lock`, or
- put `"bevyVersion": "0.20.0"` in `bevy-mcp.config.json`.

## A version mismatch warning on startup

If the config pins one version but the docs on disk were built from another,
every answer would be quietly attributed to the wrong release, so the server
reports the discrepancy instead of hiding it. Point `docDir` at the docs for the
version you actually target, or change `bevyVersion`.

## `bevy_examples` returns nothing, or only a dozen snippets

The engine `examples/` directory was not found. Clone Bevy at your version and
point `bevySrcDir` (config) / `BEVY_SRC_DIR` (env) at it:

```bash
git clone --depth 1 --branch v0.20.0 --filter=blob:none --sparse \
  https://github.com/bevyengine/bevy.git ~/.cache/bevy-mcp/bevy-src-0.20.0
git -C ~/.cache/bevy-mcp/bevy-src-0.20.0 sparse-checkout set examples
```

Without it you still get the Book's quick-start snippets, and the index has to
be rebuilt for the examples to appear.

## `bevy_api_diff` says the comparison is ambiguous

That is deliberate. With more than two versions installed, more than one pair
could be "the" comparison, and guessing would answer a different question than
the one asked. Name them:

```
bevy_api_diff { "symbol": "Sphere", "versions": "0.15.3,0.20.0" }
```

`bevy_indexed_versions` lists what is available.

## `bevy_api_diff` says "not indexed"

Asking about a version the server cannot answer for returns an error rather than
substituting another version's API. Install that version
(`bevy-mcp fetch-index <version>`) or point at a local doc tree with
`BEVY_EXTRA_VERSIONS="0.18.1=/path/to/target/doc"`.

## A new version is installed, but the server does not see it

An MCP server is a long-lived child process: it reads the registry once at
startup. Restart it from your client (in pi, `/mcp reconnect bevy`; most other
clients re-spawn it when the session restarts) and the new versions appear.

## `npm install -g github:...` fails with `EALLOWGIT`

npm 12 disables fetching git dependencies by default. That is the reason for the
flag in the install command:

```bash
npm install -g --allow-git=all github:kinkirill/bevy_manual_mcp
```

If you would rather not pass it, clone the repository and run it from the
checkout - that needs no npm flags at all.

## `fetch-index` cannot find a download

Two common causes:

- **No release for that version.** Check `bevy_indexed_versions`, or the
  Releases page. Build it locally instead
  ([GETTING-API-DOCS.md](GETTING-API-DOCS.md)).
- **docs.rs is rate-limiting a `fetch-docs` run.** The mirror is resumable:
  re-run the same command and it fetches only what is missing.

## The index is stale after upgrading Bevy

A patch upgrade (`0.19.0 → 0.19.1`) does not change APIs, and the existing index
stays accurate - the server reports this rather than nagging. A minor upgrade
(`0.19 → 0.20`) needs the new index:

```bash
bevy-mcp fetch-index 0.20.0
```

## Server will not start

Run it directly to see the diagnostics; logs go to stderr because stdout is
reserved for the MCP JSON-RPC stream:

```bash
node index.js
```

If your client shows a protocol error, check that nothing else is printing to
stdout. A stray `console.log` anywhere in the startup path would corrupt the
stream.
