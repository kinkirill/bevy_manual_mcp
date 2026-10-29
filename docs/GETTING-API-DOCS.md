# Getting the API docs

The server answers from a compiled corpus for one Bevy version. You normally do
not build it: the first server start downloads a prebuilt bundle, and
`fetch-index` installs one explicitly.

## Install a prebuilt index

```bash
bevy-manual-mcp fetch-index 0.20.1     # explicit version
bevy-manual-mcp fetch-index            # detected version
bevy-manual-mcp fetch-index 0.20.1 --force
```

`fetch-index` tries the exact release tag (`v0.20.1`), then the Bevy minor
(`v0.20`). The manifest records the exact corpus it contains; a patch resolves
to its minor's newest corpus when no exact bundle exists. It verifies size and
SHA-256, unpacks into a staging directory, validates `corpus.rkyv` with
`bytecheck`, and only then moves it into `data/versions/<exact-version>/`. A
partial file never becomes loadable.

Where the bundle comes from:

- default: `https://github.com/kinkirill/bevy_manual_mcp/releases/download`
- override with `BEVY_MCP_INDEX_BASE_URL` (mirrors and tests)
- `BEVY_MCP_OFFLINE=1` refuses all downloads

A bundle contains:

```
corpus.rkyv             records, interned arena, symbols, name tokens
tantivy/                text index (ids only)
corpus.manifest.json    size, SHA-256, counts
meta.json               build provenance
metadata/               features.json, error-codes/, compat.json
```

The metadata is what makes `bevy_check_manifest`, `bevy_explain_error`,
`bevy_perf_advisor` and `bevy_ecosystem_compat` work after a clean install.

## First-run auto-fetch

With a detected project version and no installed corpus, the server downloads
the bundle automatically at startup. Progress goes to stderr; MCP stdout stays
clean. A failed download does not kill the server — it logs the error and the
tool calls explain that no corpus is installed. Set `BEVY_MCP_OFFLINE=1` to
disable this.

## Build from a local rustdoc tree

If you already have `cargo doc` output or a docs.rs mirror:

```bash
bevy-manual-mcp build --doc-dir target/doc --out data/versions/0.20.1
```

`--doc-dir` (or `BEVY_DOC_DIR`) ingests the rustdoc HTML directly: items,
struct fields, enum variants, methods, associated items and doc examples.
Website prose, engine examples and error codes are added on top when their
directories are configured (`BEVY_WEBSITE_DIR`, `BEVY_EXAMPLES_DIR`,
`BEVY_META_DIR`).

## Rebuild from canonical NDJSON

`records.ndjson` stays the canonical, diffable source. The archive is derived:

```bash
bevy-manual-mcp build --records records.ndjson --out data/versions/0.20.1
```

This path does not parse HTML, so it is much faster, but it depends on a
previously generated NDJSON file.

## Mirror docs.rs yourself

```bash
bevy-manual-mcp fetch-docs 0.20.1 --out ~/.cache/bevy-mcp/bevy-0.20.1
```

It discovers item pages from `all.html`, caches the page list, resumes missing
pages, and uses a shared throttle plus four workers. `FETCH_CONCURRENCY` and
`FETCH_MIN_INTERVAL_MS` tune the download. If docs.rs rate-limits, wait and
re-run the same command; only missing pages are fetched.

## Fetch website prose and examples

```bash
bevy-manual-mcp fetch-website --out vendor/bevy-website --ref main
```

This performs a sparse, blob-filtered `git clone` and copies only `.md`, `.rs`
and `LICENSE` files. Media is never downloaded.

Engine examples are auto-detected from the published `bevy` crate in
`$CARGO_HOME/registry/src/*/bevy-<version>/examples`, or can be pointed at with
`BEVY_EXAMPLES_DIR` / `BEVY_SRC_DIR`.

## Harvest metadata

```bash
bevy-manual-mcp harvest-meta 0.20.1 --out vendor/bevy-meta/0.20.1
bevy-manual-mcp harvest-meta 0.20.1 --tag v0.20.1 --force
```

This fetches the feature graph (including implicit optional-dependency
features), closure, default features, profiles, plugin gates, panic-site codes
and error-code guides from the Bevy repository at the tag, and writes
`features.json`, `error-codes/` and `meta.json`.

Plugin compatibility:

```bash
bevy-manual-mcp harvest-compat --out vendor/ecosystem
```

This uses the crates.io sparse index (one request per plugin crate) and writes
`compat.json` with a `meta` provenance block.

## Produce a release bundle

```bash
bevy-manual-mcp build --doc-dir ~/.cache/bevy-mcp/bevy-0.20.1 \
  --out data/versions/0.20.1 \
  --pack dist/bevy-0.20.1-fmt1.tar.zst \
  --manifest dist/index-manifest.json \
  --revision 1
```

The manifest is what `fetch-index` consumes. Publish the asset and manifest
under `v<bevy-version>` in GitHub Releases.

## Data locations

```
data/versions/<version>/          corpus.rkyv, tantivy/, manifests, metadata/
data/corpora/<crate>/<version>/   plugin corpora
~/.cache/bevy-mcp/bevy-<version>/ docs.rs mirror (build input only)
vendor/bevy-meta/<version>/       vendored feature/error metadata
vendor/ecosystem/compat.json      plugin compatibility snapshot
```

`data/` is machine-local and git-ignored. The vendored metadata and website
prose are committed source inputs, not part of the crate package.
