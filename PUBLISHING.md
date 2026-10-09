# Publishing bevy-mcp

This is the maintainer's checklist. It assumes you have write access to
`kinkirill/bevy_manual_mcp` and publish rights for the `bevy-mcp` npm package.

## The mental model

Version-accuracy is the whole product, so the project ships **one release per
Bevy minor**. `bevy-mcp@0.20.x` answers for any Bevy `0.20.y`, because Bevy's
patch releases never change the public API.

Three layers, three homes, on purpose:

| Layer | Where it lives | Why |
|---|---|---|
| Code + vendored prose (`.md`/`.rs`) | git repo + npm | small, changes when you change it |
| Built search index (~74 MB gzip) | GitHub Release asset | 250 MB raw, identical for every user |
| rustdoc mirror (1.6 GB) | `scripts/fetch-docs.mjs`, on demand | only needed to rebuild the index |

The release asset is what makes `npx bevy-mcp` pleasant. Without it, a first run
has to mirror docs (~15 min) and build (~15 min).

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
   - attaches it to the `v0.21.0` GitHub Release,
   - publishes to npm via trusted publishing (OIDC) — no token secret.

   You can rebuild by hand with `workflow_dispatch` if a step fails.

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

npm is retiring tokens that bypass 2FA, so this project does **not** use an
`NPM_TOKEN`. As of July 2026 such tokens can no longer manage packages, and they
are slated to lose direct publish around January 2027. Instead the release job
authenticates with GitHub's **OIDC** token, which npm exchanges for a short-lived,
workflow-scoped credential and records as provenance.

### One-time: the first publish is manual

A trusted publisher can only be configured on a package that already exists, so
the very first release is published by hand:

```bash
npm login
cd bevy_manual_mcp
npm publish --access public
```

This needs 2FA. npm **no longer allows adding a TOTP authenticator app** (new
TOTP enrolment is rejected with *"Adding a new TOTP 2FA is no longer supported"*),
so add a **security key** at <https://npmjs.com/settings/kinkirill/tfa>. You do
not need a USB key: the flow accepts a platform authenticator, i.e. your laptop's
fingerprint reader, Windows Hello, Touch ID, or your phone's face/fingerprint.

### Then: authorise this repo

On npmjs.com → your package → **Settings → Trusted Publisher → GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `kinkirill` |
| Repository | `bevy_manual_mcp` |
| Workflow filename | `release.yml` (filename only, with extension) |
| Environment name | *(leave empty)* |
| Allowed actions | enable **npm publish** (and `npm dist-tag` if you want it) |

After that, a tag push publishes without any secret. Trusted publishing needs npm
CLI ≥ 11.5.1, which the Node 24 runner provides — do not downgrade the runner's
Node version.

### Repository secrets

| Secret | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | `release.yml` (release asset) | provided automatically; `contents: write` is requested in the workflow. |
| `NPM_TOKEN` | — | intentionally unused; see above. |

## Registering a release with MCP directories

After a release exists, list the server so people can find it:

- **Official MCP registry** — `server.json` is already in the repo. Publish with
  the [`mcp-publisher`](https://github.com/modelcontextprotocol/registry) CLI.
- **Smithery**, **mcp.so**, **Glama**, **PulseMCP** — submit the GitHub URL.

Keep `server.json` in sync with `package.json`: the registry rejects a version
that numbers differently from the published package.

## Versioning rules

- `bevy-mcp@X.Y.*` answers for Bevy `X.Y.*`.
- Bump the bevy-mcp patch (`0.20.0 → 0.20.1`) only for changes to the **tooling**
  — parser fixes, new tools. The index is unchanged, so users need not upgrade.
- Never publish a pre-release of Bevy as a target; `bevy_check_version` and the
  docs.rs mirror both expect a stable `X.Y.Z`.
