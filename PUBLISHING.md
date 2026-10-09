# Publishing bevy-mcp

This is the maintainer's checklist. It assumes you have write access to
`kinkirill/bevy_manual_mcp`. **Distribution is GitHub-first** — the repository
and its Release assets are the whole channel, so no npm account is required.

## The mental model

Version-accuracy is the whole product, so the project ships **one release per
Bevy minor**. The `v0.20.x` release answers for any Bevy `0.20.y`, because Bevy's
patch releases never change the public API.

Three layers, three homes, on purpose:

| Layer | Where it lives | Why |
|---|---|---|
| Code + vendored prose (`.md`/`.rs`) | git repo | small, changes when you change it |
| Built search index (~67 MB gzip) | GitHub Release asset | 250 MB raw, identical for every user |
| rustdoc mirror (1.6 GB) | `scripts/fetch-docs.mjs`, on demand | only needed to rebuild the index |

Users install the server with `npm install -g github:kinkirill/bevy_manual_mcp`
(or run it via `npx --allow-git=all github:…`), and fetch the index from the Release
asset. The Release asset is what keeps the first run to a ~67 MB download instead
of a
~30 minute docs mirror plus build.

## Adding a new Bevy minor (e.g. 0.21)

1. **Bump the version**
   - `package.json` → `"version": "0.21.0"`
   - `server.json` → `"version": "0.21.0"` (both places: top level and inside
     `packages[0]`)
   - `bevy-mcp.config.example.json` → `"bevyVersion": "0.21.0"` and the
     `~/.cache/bevy-mcp/bevy-0.21.0` paths

2. **Refresh the vendored prose** (picks up new migration guides and Book pages)
   ```bash
   node scripts/fetch-website.mjs
   git add vendor/bevy-website && git commit -m "vendor: refresh bevy-website prose"
   ```
   The script uses a partial sparse clone, so the ~270 MB of news media is never
   downloaded.

3. **Tag and push**
   ```bash
   git tag v0.21.0
   git push origin main --tags
   ```

4. **Done.** The `release` workflow then:
   - mirrors rustdoc from docs.rs,
   - sparse-clones the engine `examples/`,
   - builds the index,
   - packages `bevy-index-0.21.0.tar.gz`,
   - attaches it to the `v0.21.0` GitHub Release.

   You can rebuild by hand with `workflow_dispatch` if a step fails. npm
   publishing is skipped unless you opt in (see *Publishing to npm* below).

## Building and publishing the index manually

If you would rather not wait on CI:

```bash
# 1. mirror rustdoc (resumable; re-run after a rate limit)
node scripts/fetch-docs.mjs 0.21.0 --out ~/.cache/bevy-mcp/bevy-0.21.0

# 2. (optional) engine examples, for bevy_examples
git clone --depth 1 --branch v0.21.0 --filter=blob:none --sparse \
  https://github.com/bevyengine/bevy.git ~/.cache/bevy-mcp/bevy-0.21.0-src
git -C ~/.cache/bevy-mcp/bevy-0.21.0-src sparse-checkout set examples

# 3. build the index
BEVY_VERSION=0.21.0 \
BEVY_DOC_DIR=~/.cache/bevy-mcp/bevy-0.21.0 \
BEVY_SRC_DIR=~/.cache/bevy-mcp/bevy-0.21.0-src \
  node scripts/build-index.mjs 0.21.0 --force

# 4. package it
node scripts/publish-index.mjs 0.21.0

# 5. attach it to the release
gh release create v0.21.0 dist/bevy-index-0.21.0.tar.gz \
  --title "Bevy 0.21 index" \
  --notes "Prebuilt Bevy 0.21 search index for bevy-mcp."
```

## Publishing to npm (trusted publishing)

## Publishing to npm (optional)

npm is **not** part of the normal flow. Distribution is GitHub-first, and
`npm install -g github:kinkirill/bevy_manual_mcp` covers installation. Everything
below is only if you later decide you also want a registry listing.

If you do, prefer **trusted publishing (OIDC)** over a token. npm is retiring
tokens that bypass 2FA — since July 2026 they cannot manage packages, and they
are slated to lose direct publish around January 2027.

1. **First publish is manual** (a trusted publisher can only be configured on a
   package that already exists):
   ```bash
   npm login
   npm publish --access public
   ```
   npm no longer accepts **new TOTP enrolment** — the CLI rejects it with
   *"Adding a new TOTP 2FA is no longer supported"* — so a security key is
   required. A phone passkey works, but the cross-device prompt is browser
   dependent; if it will not complete, generate a short-lived **bypass-2FA
   granular token** from the phone (where the passkey resolves locally) and use
   `npm publish --//registry.npmjs.org/:_authToken=<token>`.

2. **Authorise this repo** — npmjs.com → package → **Settings → Trusted
   Publisher → GitHub Actions**:

   | Field | Value |
   |---|---|
   | Organization or user | `kinkirill` |
   | Repository | `bevy_manual_mcp` |
   | Workflow filename | `release.yml` (filename only, with extension) |
   | Environment name | *(leave empty)* |
   | Allowed actions | enable **npm publish** |

3. **Enable it in CI** — create the repository variable `PUBLISH_NPM=true`
   (Settings → Secrets and variables → Actions → Variables). The release job's
   npm step is gated on it, so tag pushes never fail on npm auth while it is
   unset.

### Repository secrets and variables

| Name | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | `release.yml` (release asset) | provided automatically; `contents: write` is requested in the workflow. |
| `PUBLISH_NPM` (variable) | `release.yml` (npm step) | unset by default; set to `true` to publish to npm. |

## Registering a release with MCP directories

After a release exists, list the server so people can find it:

- **GitHub topics** — add `mcp`, `model-context-protocol`, `bevy` to the repo so
  it shows up in GitHub search.
- **Smithery**, **mcp.so**, **Glama**, **PulseMCP**, **awesome-mcp-servers** —
  submit the GitHub URL. These accept a GitHub repo without an npm package.
- **Official MCP registry** — `server.json` currently declares an npm package, so
  it only validates after a publish to npm. Until then, either leave it alone or
  point it at the repository.

## Versioning rules

- Tags `vX.Y.*` answer for Bevy `X.Y.*`.
- Bump the patch (`0.20.0 → 0.20.1`) only for changes to the **tooling** — parser
  fixes, new tools. The index is unchanged, so users need not upgrade.
- Never target a pre-release of Bevy; `bevy_check_version` and the docs.rs mirror
  both expect a stable `X.Y.Z`.
