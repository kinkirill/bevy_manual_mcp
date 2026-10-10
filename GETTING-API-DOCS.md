# Getting the API docs

bevy-mcp answers from a local index of Bevy's rustdoc, the Book, the migration
guides and the engine examples. There are two ways to get that index: install a
prebuilt one (seconds), or build it yourself from a rustdoc mirror (minutes).

- [Install the prebuilt index](#install-the-prebuilt-index)
- [Build it yourself](#build-it-yourself)
- [Using `cargo doc` instead](#cargo-doc---only-with---no-deps-and-with-caveats)
- [Startup cost](#startup-cost)

Back to the [README](README.md).

---

## Install the prebuilt index

The index for a released Bevy minor is identical for everyone, so it is built
once and published as a GitHub Release asset (~67 MB compressed). This is the
fast path:

```bash
bevy-mcp fetch-index 0.20.0    # omit the version to read Cargo.lock
```

It unpacks into `data/versions/0.20.0/` (or `$BEVY_MCP_DATA_DIR`), and merges the
version into `data/registry.json` without disturbing anything already installed -
so you can keep several versions side by side and compare them with
`bevy_api_diff`.

Indexes are published for **0.15.3, 0.16.1, 0.17.3, 0.18.1, 0.19.1 and 0.20.0**.
If `fetch-index` reports no asset for a version, build it yourself (below) or ask
for a release.

---

## Build it yourself

### Recommended - mirror from docs.rs

**Use the docs.rs mirror** - it is the source this server is tuned for.

```bash
node scripts/fetch-docs.mjs 0.20.0
```

```json
{ "bevyVersion": "0.20.0", "docDir": "~/.cache/bevy-mcp/0.20.0" }
```

This downloads ~7,900 rustdoc pages for the `bevy` facade, which re-exports the
whole public API. Crucially, each page carries rustdoc's *source link* to the
defining sub-crate (`docs.rs/bevy_app/…`), which the server uses to attribute
items to `bevy_app`, `bevy_ecs`, … and to filter out dependency boilerplate. The
download is resumable: re-run after a rate-limit and it fetches only what is
missing.

Then build the index:

```bash
node scripts/build-index.mjs 0.20.0 --force
```

That command is headless: it builds and exits. Starting the server
(`node index.js`) builds lazily too, but it then blocks on stdio, so it is the
wrong tool for a script or CI.

### Rebuild several existing mirrors

```bash
npm run rebuild-all -- 0.19.1 0.20.0
npm run rebuild-all -- --mirror-root /path/to/mirrors --data /path/to/data
```

With no versions, this rebuilds 0.15.3, 0.16.1, 0.17.3, 0.18.1, 0.19.1 and
0.20.0 in that order. Each build runs offline with `--force`; it never downloads
documentation. Missing mirrors are reported and skipped. Failed builds are
reported, the remaining versions are attempted, and the command exits nonzero.

The command uses `docDir`, `mirrorDir` and `dataDir` from the normal configuration
(including their environment overrides). It also checks `bevy-docs-<version>`
inside the package and the legacy `~/.cache/bevy-mcp/bevy-<version>` mirrors.
`--mirror-root` limits lookup to `<root>/<version>`, `<root>/bevy-<version>` and
`<root>/bevy-docs-<version>`. `--data` overrides the configured index directory.
For several versions, a shared configured documentation directory is used only
for its detected documentation version or the configured project's version;
untagged shared mirrors require an explicit single version.
The legacy `scripts/rebuild-all-indexes.sh` command remains available after
`npm run build`; Windows users can run the npm command or its `.mjs` launcher.

### Add the engine examples (optional)

`bevy_examples` prefers real engine examples. Without an engine checkout you get
only the Book's quick-start snippets, because the examples are the one thing that
is not in the rustdoc mirror. A sparse clone is enough:

```bash
git clone --depth 1 --branch v0.20.0 --filter=blob:none --sparse \
  https://github.com/bevyengine/bevy.git ~/.cache/bevy-mcp/bevy-src-0.20.0
git -C ~/.cache/bevy-mcp/bevy-src-0.20.0 sparse-checkout set examples
```

Point `bevySrcDir` (config) or `BEVY_SRC_DIR` (env) at it before building.

---

## `cargo doc` - only with `--no-deps`, and with caveats

`cargo doc -p bevy` documents Bevy **and its entire dependency tree** - roughly
280 crates and 65,000 pages of `libc`, `ash`, `wayland`, `alsa`, … Pointing the
server at that output floods the index with dependency APIs, so don't.

`cargo doc -p bevy --no-deps` produces a clean `bevy/` facade (~7,900 pages), but
because dependency sources are not rendered those defining-crate source links
are **absent**. The server then cannot tell a `bevy_app` item from a `bevy_ecs`
one: every record collapses to `crate: "bevy"` and `bevy://crate/…` grouping
degrades.

For a project on Bevy's default features the mirror and your own `cargo doc`
contain the same public API, so **the mirror is strictly better**. Reach for
`cargo doc` only if you have customised Bevy's features heavily.

---

## Startup cost

A cold build of the full corpus takes roughly 5-7 minutes at a 2 GB heap and is
then persisted. For Bevy 0.19.1 that is ~270k records: 265,741 rustdoc items,
3,389 website prose chunks and 445 examples. You can skip the build entirely by
installing a prebuilt index; otherwise every later run streams `records.ndjson`
and imports `text-index.json` in about 2-5 seconds.

Deleting `data/` forces a cold rebuild. The rustdoc mirrors under
`~/.cache/bevy-mcp/` are only needed to rebuild - roughly 1.6 GB each - so they
are safe to delete once the index exists.

---

## Publishing an index

Maintainers: see [PUBLISHING.md](PUBLISHING.md) for the release ritual, including
`scripts/publish-index.mjs`, which packages a built index into the tarball that
`fetch-index` downloads.
