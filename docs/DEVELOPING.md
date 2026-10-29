# Developing

Back to the [README](../README.md).

## Requirements

Rust stable (the crate declares `rust-version = "1.88"`), `cargo`, and a normal
Cargo project for testing version detection. Node is not required.

## Build and test

```bash
cargo build --release
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo package --no-verify
```

The suite includes:

- unit tests for archive/interner, search ranking, analysers, ingest and
  harvesters;
- archive tests that build real corpora, pack/fetch bundles and ingest a
  `cargo doc` tree;
- stdio MCP tests that spawn the binary and exercise tools, resources,
  auto-fetch and metadata.

## Layout

```
src/main.rs          CLI: serve, build, fetch-index, search, lookup, harvest…
src/server.rs        MCP tools, resources and output
src/archive.rs       rkyv schema, builder, mmap loader
src/search.rs        hybrid ranking, filters, suggestions, migrations
src/text.rs          tantivy schema/tokenizer/index
src/analysis/        features, systems, filters, conflicts, compat, errors, perf
src/ingest/          rustdoc HTML, website markdown, examples, metadata
src/harvest/         docs.rs, website, feature graph, compat harvesters
src/bundle.rs        bundle pack/install, release manifests, fetch-index
tests/               archive and MCP integration suites
```

## Rebuilding an index

From a local docs tree (fastest and fully offline once the mirror exists):

```bash
bevy-manual-mcp build --doc-dir ~/.cache/bevy-mcp/bevy-0.20.0 \
  --out data/versions/0.20.0
```

From canonical NDJSON (rustdoc records already generated):

```bash
bevy-manual-mcp build --records records.ndjson \
  --out data/versions/0.20.0
```

Both paths add website prose, engine examples and error codes when their
directories are configured. A full release build is ~30 s for 0.20.0.

Produce a release asset and its manifest:

```bash
bevy-manual-mcp build --doc-dir "$HOME/.cache/bevy-mcp/bevy-0.20.0" \
  --out data/versions/0.20.0 \
  --pack dist/bevy-0.20.0-fmt1.tar.zst \
  --manifest dist/index-manifest.json \
  --revision 1
```

## Versioning policy

- The **crate** is semver-versioned on crates.io. Tool, ranking, CLI and docs
  changes are patch/minor releases; they do not require a reindex.
- **Indexes** are Bevy-versioned GitHub Release assets, tagged by Bevy minor
  (`v0.20`) and refreshed with `--revision` when a patch lands. They are
  independent of the crate version.
- The hard boundary is the compiled format: changing the rkyv layout, the
  tantivy schema/tokenizer, or the bundle manifest requires bumping
  `FORMAT_VERSION` / `RUST_MANIFEST_VERSION` and rebuilding all bundles.
  `fetch-index` refuses a mismatched format.

## Release

See [PUBLISHING.md](PUBLISHING.md). In short: build and upload the six index
bundles first, then `cargo publish`, then publish the MCP registry entry.

## Docs

- [Getting the API docs](GETTING-API-DOCS.md)
- [How it works](HOW-IT-WORKS.md)
- [Publishing](PUBLISHING.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Third-party notices](THIRD-PARTY-NOTICES.md)
- [Prompt examples](prompts/)
