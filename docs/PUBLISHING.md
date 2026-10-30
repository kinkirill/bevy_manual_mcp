# Publishing

Back to the [README](../README.md).

Two artifacts are published independently:

1. the **crate** `bevy-manual-mcp` (binary `bevy-manual-mcp`) on crates.io;
2. **index bundles** for each Bevy version on GitHub Releases.

The crate version does not track a Bevy version. Releases are not previews;
use the current version on crates.io.

Index bundles only need rebuilding when corpus content, bundle metadata
(including `features.json`), the rkyv layout, the Tantivy schema/tokenizer, or
the bundle manifest changes. A crate-only change does not require new index
bundles. Existing bundles remain compatible as long as `FORMAT_VERSION` and
`RUST_MANIFEST_VERSION` are unchanged, but new metadata fields only appear after
the bundle is rebuilt and published under a new revision.

## Prerequisites

- a clean checkout of `main`
- Rust stable, `cargo`, `git`, and network access to crates.io / GitHub
- a crates.io token with publish rights for `bevy-manual-mcp`
- write access to `kinkirill/bevy_manual_mcp` for the release assets

## Verify before publishing

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo package --list
cargo package --no-verify
```

`cargo package` must stay small. The `include` list ships only the Rust sources,
`Cargo.toml`, `Cargo.lock`, `README.md`, `LICENSE` and `docs/`.
Vendored corpora and website prose stay out of the crate; they live in bundles
or inside the binary's ingest path.

## Build one index bundle

```bash
VERSION=0.20.1
REVISION=1

bevy-manual-mcp fetch-docs "$VERSION" --out "$HOME/.cache/bevy-mcp/bevy-$VERSION"
bevy-manual-mcp harvest-meta "$VERSION" --out "$PWD/vendor/bevy-meta/$VERSION" --force
bevy-manual-mcp harvest-compat --out "$PWD/vendor/ecosystem"
bevy-manual-mcp fetch-website --out "$PWD/vendor/bevy-website"

BEVY_VERSION="$VERSION" \
BEVY_MCP_DATA_DIR="$PWD/data" \
BEVY_META_DIR="$PWD/vendor/bevy-meta" \
BEVY_WEBSITE_DIR="$PWD/vendor/bevy-website" \
BEVY_EXAMPLES_DIR="${CARGO_HOME:-$HOME/.cargo}/registry/src" \
bevy-manual-mcp build \
  --doc-dir "$HOME/.cache/bevy-mcp/bevy-$VERSION" \
  --out "data/versions/$VERSION" \
  --pack "dist/bevy-$VERSION-fmt1.tar.zst" \
  --manifest "dist/index-manifest.json" \
  --revision "$REVISION"
```

The example path assumes examples were resolved by the helper; in CI use a
sparse `bevy` checkout and point `BEVY_EXAMPLES_DIR` at `<checkout>/examples`.

Upload `bevy-<version>-fmt1.tar.zst` and `index-manifest.json` to the GitHub
Release tagged by Bevy **minor**, `v<major.minor>` (e.g. `v0.20`). The manifest
records the exact corpus version (`0.20.1`). `fetch-index` tries the exact tag
first, then the minor tag, verifies SHA-256 and size, and only then installs.

The six supported corpora are `0.15.3`, `0.16.1`, `0.17.3`, `0.18.1`, `0.19.1`
and `0.20.1`, in releases `v0.15` … `v0.20`. When a Bevy patch lands, rebuild
the same minor release with the new patch and bump `--revision`; users on any
patch of that minor resolve to the newest corpus unless an exact release exists.

## Publish the crate

```bash
cargo publish --dry-run
cargo publish
```

After the crate is live:

- `server.json` advertises `registryType: "cargo"`, `identifier:
  "bevy-manual-mcp"`, and the current crate version;
- publish the MCP registry entry;
- verify a clean machine: `cargo install bevy-manual-mcp`, point it at a Cargo
  project, run `fetch-index` (or let the background fetch finish), then run one
  query.

## Registry metadata workflow

The `registry-version-bump` workflow is independent from normal CI and from
`index-release`. Dispatch it manually after a crate release:

1. read the version from `Cargo.toml`
2. update both version fields in `server.json`
3. commit and push `server.json` if it changed
4. verify that the crate version exists on crates.io
5. validate and publish the MCP Registry entry using GitHub OIDC

Use `dry_run: true` to validate the metadata and inspect the diff without
committing or publishing.

## CI/release automation

The `index-release` workflow builds one bundle per dispatch (version + revision
inputs), uploads the asset and manifest, and optionally publishes the crate when
explicitly requested. CI runs formatting, clippy and tests on Linux, macOS and
Windows. Never publish from a dirty or untested tree.
