# bevy-mcp

I built this MCP because Bevy is a fast-moving project that changes with every
release. Its documentation is large and scattered, so finding an answer that
actually matches *your* version often means digging through rustdoc, the Book,
migration guides and older forum threads - and still landing on something
written for a different release. This server removes that friction: instead of
searching and guessing, you ask your agent a question and it answers from
knowledge pinned to the exact Bevy version your project is using.

It is primarily **a reference to ask questions of**. The kind of question it
exists for:

> “How do I create a 3D sphere with a given radius?”

`Sphere::new(radius)`. And the answer includes where that type lives *in your
version*: `bevy::math::primitives::Sphere` in 0.19, but `bevy::shape::Sphere` in
0.20, after the primitives were split into their own crate. Same question,
different answer - and importing the stale path simply fails to compile.

You can also point a coding agent at it, and it will stop inventing signatures
for your version - a genuine side benefit. But that is not what it is for: the
point is that when you ask Bevy something, the answer you get is the one that
matches your `Cargo.lock`.

An MCP server that gives your agents **version-accurate** Bevy knowledge: the
real API signatures from rustdoc, the Bevy Book, migration guides, release notes
and runnable examples - all pinned to the Bevy version your project actually
uses.

The problem it solves: LLMs have stale, hallucinated Bevy APIs. Bevy breaks
compatibility every release, so a confident answer given from memory is often
wrong for the version you are actually on. This server makes the model look the
answer up instead, and makes it impossible to silently answer from the wrong
version's docs.

---

## Quick start

There is no npm package: the server is installed straight from this repository,
and the search index comes from the GitHub Releases of this repository.

### Install the CLI (recommended)

```bash
# npm 12 disables fetching git dependencies by default, hence the opt-in flag
npm install -g --allow-git=all github:kinkirill/bevy_manual_mcp

bevy-mcp fetch-index 0.20.0   # download the prebuilt index (~67 MB)
bevy-mcp status               # show what was auto-detected
bevy-mcp                      # start the stdio server
```

Or clone it yourself, which needs no npm flags at all:

```bash
git clone https://github.com/kinkirill/bevy_manual_mcp
cd bevy_manual_mcp && npm install
./bin/bevy-mcp.js fetch-index 0.20.0
```

Register it with your MCP client. If the client spawns the command itself, run
it through `npx` (no global install needed) and pass the project path, since the
Bevy version is read from `Cargo.lock`:

```json
{
  "command": "npx",
  "args": ["-y", "--allow-git=all", "github:kinkirill/bevy_manual_mcp"],
  "env": { "BEVY_PROJECT_ROOT": "/path/to/your/bevy/game" }
}
```

If you cloned instead, point the client at the checkout - no npm involvement:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/bevy_manual_mcp/index.js"],
  "env": { "BEVY_PROJECT_ROOT": "/path/to/your/bevy/game" }
}
```

The prebuilt index turns the first run into a ~67 MB download instead of a local
rustdoc build - see [Distribution and versioning](#distribution-and-versioning).

### Configure it

`bevy-mcp.config.json` is the whole setup - no environment variables needed. The
minimal version points at your game and lets the server find the docs itself:

```json
{
  "projectRoot": "/path/to/your/bevy/game",
  "websiteDir": "./vendor/bevy-website"
}
```

It reads the Bevy version from `Cargo.lock` and the API from `target/doc`. If you
mirror docs from docs.rs instead, pin the version and doc dir explicitly:

```json
{
  "bevyVersion": "0.20.0",
  "docDir": "~/.cache/bevy-mcp/bevy-0.20.0",
  "websiteDir": "./vendor/bevy-website"
}
```

### Running it

`index.js` is a **stdio MCP server**, not a daemon and not a web service. Your
MCP client (Claude, opencode, Zed, pi, …) spawns it as a child process and talks
JSON-RPC over stdin/stdout. You do not "start it inside a project" - you register
it with a client, and point the *config* at your project.

You can still run it by hand to check it boots (logs go to stderr; stdout is
reserved for the protocol):

```bash
node index.js
# [bevy-mcp] config: loaded .../bevy-mcp.config.json
# [bevy-mcp] version 0.20.0: loaded persisted index in 2602ms
# [bevy-mcp] ready - bevy-mcp 0.20.0, bevy 0.20.0
```

The first run either downloads the prebuilt index or builds it from rustdoc
(one-time; see *Startup cost* below). Every run after that reloads from disk in a
couple of seconds.

---

## Getting API docs

### Recommended - install the prebuilt index

The index for a released Bevy minor is identical for everyone, so it is built
once and published as a GitHub Release asset (~67 MB compressed). This is the
fast path:

```bash
bevy-mcp fetch-index 0.20.0    # omit the version to read Cargo.lock
```

It unpacks into `data/versions/0.20.0/` (or `$BEVY_MCP_DATA_DIR`). To rebuild it
from scratch instead, keep reading.

### Building it yourself - mirror from docs.rs

**Use the docs.rs mirror** - it is the source this server is tuned for.

```bash
node scripts/fetch-docs.mjs 0.20.0
```

```json
{ "bevyVersion": "0.20.0", "docDir": "~/.cache/bevy-mcp/bevy-0.20.0" }
```

This downloads ~7,900 rustdoc pages for the `bevy` facade, which re-exports the
whole public API. Crucially, each page carries rustdoc's *source link* to the
defining sub-crate (`docs.rs/bevy_app/…`), which the server uses to attribute
items to `bevy_app`, `bevy_ecs`, … and to filter out dependency boilerplate. The
download is resumable: re-run after a rate-limit and it fetches only what is
missing.

### `cargo doc` - only with `--no-deps`, and with caveats

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

## Distribution and versioning

Releases track Bevy's minor version: the **`v0.20.x` release** answers for any
Bevy `0.20.y`, because patch releases never change the public API. Match the
minor and you are done.

To keep the first run cheap, the pieces are distributed separately:

| Piece | Where | Size |
|---|---|---|
| Server code + bundled Book/migration prose | this repository (`npm install -g --allow-git=all github:…`) | a few MB |
| Prebuilt index for a Bevy minor | GitHub Releases, via `bevy-mcp fetch-index` | ~67 MB |
| rustdoc mirror (only needed to rebuild) | `bevy-mcp fetch-docs` | ~1.6 GB |

The index holds API metadata, documentation strings, migration guides and
examples - not engine source. Maintainers: see [PUBLISHING.md](PUBLISHING.md)
for the release ritual.

---

## Registering with an MCP client

All of these assume the settings live in `bevy-mcp.config.json`, so the only
thing a client needs is the command. `index.js` takes no arguments.

### Generic / most clients

Claude Desktop, Cursor, Windsurf, Cline, Roo, Continue, **Hermes** and other
custom agents all accept the standard `mcpServers` shape:

```json
{
  "mcpServers": {
    "bevy": {
      "command": "node",
      "args": ["/absolute/path/to/bevy-manual-mcp/index.js"]
    }
  }
}
```

Common config locations:

| Client | File |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` (or `.cursor/mcp.json` per project) |
| Cline / Roo / Continue | their MCP settings (same JSON) |

Any client that speaks stdio MCP can run this server. If yours is not listed,
use the generic block and check its docs for where `mcpServers` goes.

### Claude Code

```bash
claude mcp add bevy -- node /absolute/path/to/bevy-manual-mcp/index.js
```

### opencode

`~/.config/opencode/opencode.jsonc` - note the key is `mcp` (not `mcpServers`)
and `command` is an **array**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bevy": {
      "type": "local",
      "command": ["node", "/absolute/path/to/bevy-manual-mcp/index.js"],
      "enabled": true
    }
  }
}
```

### Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "bevy": {
      "source": "custom",
      "command": "node",
      "args": ["/absolute/path/to/bevy-manual-mcp/index.js"]
    }
  }
}
```

### pi

```bash
pi mcp add bevy --exposure direct \
  --description "Version-accurate Bevy API docs, Book, migration guides and examples" \
  -- node /absolute/path/to/bevy-manual-mcp/index.js
```

or `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "bevy": {
      "command": "node",
      "args": ["/absolute/path/to/bevy-manual-mcp/index.js"],
      "exposure": "direct"
    }
  }
}
```

`exposure` is a pi concept: `direct` declares the tools up front (handiest for a
small, frequently used server), the default `codemode` reaches them through
scripts, and `deferred` loads them via tool search.

### VS Code / GitHub Copilot

`.vscode/mcp.json` - note the top-level key is `servers`:

```json
{
  "servers": {
    "bevy": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/bevy-manual-mcp/index.js"]
    }
  }
}
```

### Instead of a config file: environment variables

Every client's `env` block works too, and **env overrides the config file**, so a
one-off override needs no file edit:

```json
"env": {
  "BEVY_PROJECT_ROOT": "/path/to/your/bevy/game",
  "BEVY_DOC_DIR": "/path/to/your/bevy/game/target/doc"
}
```

---

## Configuration

Settings can live in a **JSON config file** or in **environment variables**.
Environment variables always win, so a one-off override still works without
touching the file. **Precedence: env var > config file > auto-detection.**

### Config file (recommended)

The server looks for `bevy-mcp.config.json` in this order:

1. `$BEVY_MCP_CONFIG` (explicit path)
2. `<projectRoot>/bevy-mcp.config.json`
3. `<this repo>/bevy-mcp.config.json`
4. `~/.config/bevy-mcp/config.json`

Relative paths inside the file resolve against the file's own directory, and
`~` is expanded. Copy `bevy-mcp.config.example.json` and edit:

```json
{
  "bevyVersion": "0.20.0",
  "docDir": "~/.cache/bevy-mcp/bevy-0.20.0",
  "websiteDir": "./vendor/bevy-website",
  "dataDir": "./data",
  "offline": false
}
```

All keys are optional:

| Key | Purpose |
|---|---|
| `projectRoot` | Cargo project used to detect the Bevy version |
| `bevyVersion` | Explicit version (`0.20.0`); alias `version` |
| `docDir` | cargo `target/doc` directory, or a `fetch-docs.mjs` mirror |
| `websiteDir` | bevy-website checkout (`./vendor/bevy-website` is bundled) |
| `bevySrcDir` | bevy engine checkout (enables `examples/` and `errors/`) |
| `examplesDir` / `errorsDir` | Explicit sub-directories |
| `mirrorDir` | Where `fetch-docs.mjs` writes downloads |
| `dataDir` | Where the persistent index is stored |
| `offline` | Never contact crates.io |
| `maxResults` | Default result count for search |
| `debug` | Verbose parse errors |

`bevy-mcp.config.json` is git-ignored (it is machine-specific); the
`*.example.json` is the one to commit.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `BEVY_PROJECT_ROOT` | Cargo project used to detect the Bevy version | `process.cwd()` |
| `BEVY_VERSION` | Explicit version override (`0.20.0`) | detected |
| `BEVY_DOC_DIR` | cargo `target/doc` directory | auto-detected from project |
| `BEVY_WEBSITE_DIR` | bevy-website checkout | `./vendor/bevy-website` |
| `BEVY_SRC_DIR` | bevy engine checkout (for `examples/`, `errors/`) | auto |
| `BEVY_EXAMPLES_DIR` | Explicit examples dir | auto |
| `BEVY_EXTRA_VERSIONS` | Additional versions to hold, e.g. `0.18.1=/path/to/doc,0.17.0=/other` | none |
| `BEVY_MCP_CONFIG` | Explicit path to a config file | auto-discovered |
| `BEVY_MCP_DATA_DIR` | Where the persistent index is stored | `<repo>/data` |
| `BEVY_MCP_FORCE_REINDEX=1` | Rebuild the index even if cached | off |
| `BEVY_MCP_OFFLINE=1` | Never contact crates.io | off |
| `BEVY_MCP_DEBUG=1` | Verbose parse errors | off |

**Version detection order:** `BEVY_VERSION` → `Cargo.lock` → `Cargo.toml` →
unset (server warns loudly, since an unknown version defeats the point).

---

## Tools

| Tool | Use it for |
|---|---|
| `bevy_api` | Exact symbol lookup → real signature, docs, and the documented `Default` value. **Start here for API questions.** |
| `bevy_api_diff` | The same symbol in each indexed version - did it actually change? |
| `bevy_search` | Hybrid search across API, book, migration guides, examples. Concepts and tasks. |
| `bevy_examples` | Runnable example code for a concrete task (2d, ui, input, audio…), led by the example's `setup`/`main` body. |
| `bevy_migration` | Breaking changes between two versions. |
| `bevy_check_version` | Is my index stale? Distinguishes patch from breaking releases. |
| `bevy_indexed_versions` | Which versions can this server answer for? |
| `bevy_index_status` | Self-diagnosis: what's indexed, which version, what's missing. |

Examples:

```
bevy_api         { "symbol": "App::add_systems" }
bevy_api         { "symbol": "Query" }
bevy_api_diff    { "symbol": "App::add_systems" }
bevy_search      { "query": "system ordering", "limit": 5 }
bevy_search      { "query": "spawn ui text", "kind": "code_example" }
bevy_examples    { "task": "2d camera", "category": "2d" }
bevy_migration   { "from_version": "0.19", "to_version": "0.20", "topic": "query" }
bevy_check_version { }
```

---

## Self-renewal and version awareness

The server checks crates.io for new releases (cached 6h, `BEVY_MCP_OFFLINE=1`
disables it) and tells the agent **what kind** of update exists. This matters
because Bevy is pre-1.0 and its minor digit is the breaking-change axis:

| Bump | Meaning | Agent should… |
|---|---|---|
| `0.19.0 → 0.19.1` | patch: bug fixes, **no API changes** | leave the code alone |
| `0.19 → 0.20` | minor: **sweeping breaking changes** | call `bevy_migration` first |
| `0.20.0-rc.2` | pre-release | never recommend as a target |

So a patch release never triggers a pointless rewrite, while a minor release
blocks on migration notes first. At startup the server also logs a one-line
notice to stderr if the project is behind - deliberately not on stdout, which
carries the MCP protocol stream.

### Comparing versions

Point it at more than one doc tree to answer "did this change?":

```bash
BEVY_EXTRA_VERSIONS="0.18.1=/path/to/0.18.1/target/doc" node index.js
```

Then `bevy_api_diff` shows a symbol per version and states plainly whether the
signature actually changed. Signatures are whitespace-normalised before
comparison, because rustdoc wraps them differently between builds and a
line-break difference is not an API change.

Asking about a version that is **not** indexed returns an error rather than
silently answering from another version - substituting a different version's
API is exactly the confusion pinning exists to prevent.

---

## How it works

```
bevy-website/content/**            ─┐
  book, migration guides, quick-start, FAQ
release-content/<ver>/**           ─┤
  per-PR migration notes, release notes
learning-code-examples/**/*.rs     ─┤
cargo target/doc/**/*.html         ─┼─> ingest ─> records ─> hybrid index
docs.rs mirror (optional)          ─┘                          │
bevy/examples/**/*.rs              ─┘                           ▼
                                                        FlexSearch (concepts)
                                  exact symbol table ──> (API symbols)
```

Three design decisions worth knowing:

**1. Every rustdoc item is its own record.** rustdoc puts a struct's methods in
the *parent's* HTML file, so naive scraping buries them. This parser emits one
record per method/assoc-item with its owner, so `Query::iter` resolves directly
instead of being lost in a wall of prose.

**2. Exact lookup beats fuzzy.** A symbol table resolves `App::add_systems`
directly; FlexSearch only handles concepts. A purely fuzzy index ranks a
paragraph above the function you're asking for.

**3. Version relevance is a ranking weight.** A migration guide whose target
version equals your pinned version outranks one for 0.4→0.5. Combined with the
"indexed for Bevy X.Y.Z" line on every result, this makes stale answers visible
rather than silent.

**4. Name matches outrank prose matches.** FlexSearch scores any occurrence in
the indexed text, so a query word matching a symbol's *name* is weighted well
above the same word buried in a doc example - and an intent verb ("spawn
camera") is treated as the question, not its subject. That is why
`bevy_search "spawn camera"` leads with `Camera` instead of a struct whose
docblock happens to contain a `spawn_camera` snippet.

**5. Defaults are part of the answer.** Trait-impl methods from std traits are
dropped as boilerplate, but a type's *documented* `impl Default` - which often
states the actual default value, orientation or units - is captured onto the
type record and surfaced by `bevy_api`. `Type::default` resolves to the type
rather than to the unrelated free `default()` function. This is deliberate:
models guess defaults wrong, and a wrong default is as damaging as a wrong
signature.

Results are cached in `data/` and invalidated by a fingerprint of the input
directories, so startup is fast after the first run.

---

## Files

```
index.js                      MCP server: tools, resources, wiring, stdio transport
bin/bevy-mcp.js               CLI: serve (default), fetch-index, fetch-docs, status
bevy-mcp.config.example.json  template config (copy to bevy-mcp.config.json)
server.json                   MCP registry manifest
PUBLISHING.md                 maintainer release checklist
vendor/bevy-website/          prose-only bevy-website (Book, guides, release notes)
src/config.js                 config-file + path + version resolution
src/store.js                  index build, persisted search index, hybrid search, ranking
src/registry.js               per-version index persistence (fast reload)
src/multiversion.js           hold several versions in one process, scope searches
src/resources.js              bevy:// URI scheme + templates
src/resources_impl.js         resource read + completion handlers
src/pagination.js             cursor pagination for list resources
src/versions.js               crates.io lookup, stable-vs-prerelease split
src/format.js                 response rendering (markdown + structuredContent)
src/ingest/rustdoc.js         rustdoc HTML parser (one record per item)
src/ingest/markdown.js        website markdown, heading chunking, classification
src/ingest/examples.js        .rs example sources (engine + book)
src/ingest/owner.js           impl-header parsing (owner type, trait)
scripts/fetch-docs.mjs        docs.rs mirror with rate-limit handling
scripts/fetch-index.mjs       download the prebuilt index from GitHub Releases
scripts/build-index.mjs       build the index headlessly (CI / manual)
scripts/publish-index.mjs     package an index bundle for a Release
scripts/fetch-website.mjs     refresh vendor/bevy-website (sparse, prose only)
test/run-tests.mjs            unit tests (uses real cargo doc output)
test/resources-test.mjs       resource conformance over a real MCP client
test/mcp-e2e.mjs              protocol-level test over stdio
```

**Startup cost.** A cold build of the full corpus (~270k records: 265k rustdoc
items, Book/migration/release prose, ~445 examples) takes roughly 12 minutes at a
2 GB heap, and is then persisted. You can skip it entirely by installing the
prebuilt index (`bevy-mcp fetch-index`, ~67 MB); otherwise every later run streams
`records.ndjson` and imports `text-index.json` in about 2-5 seconds. Deleting
`data/` forces a cold rebuild.

Run tests:

```bash
npm test
BEVY_VERSION=0.20.0 BEVY_DOC_DIR=... node test/resources-test.mjs
```

---

## Troubleshooting

**"Records: 0" or no API results** → the rustdoc index is empty. Run
`cargo doc` in your Bevy project or `node scripts/fetch-docs.mjs <version>`, then
call `bevy_index_status`.

**"Bevy version: UNKNOWN"** → set `BEVY_VERSION` or `BEVY_PROJECT_ROOT`.

**`bevy_examples` returns nothing** → the engine `examples/` dir wasn't found.
Clone Bevy at your version and point `bevySrcDir` (config) / `BEVY_SRC_DIR` (env)
at it. A sparse checkout is enough:

```bash
git clone --depth 1 --branch v0.20.0 --filter=blob:none --sparse \
  https://github.com/bevyengine/bevy.git ~/.cache/bevy-mcp/bevy-0.20.0
cd ~/.cache/bevy-mcp/bevy-0.20.0 && git sparse-checkout set examples
```

Without it you only get the Book's ~13 quick-start snippets.

**Server won't start** → check `node index.js` directly; diagnostics go to
stderr. stdout is reserved for the MCP JSON-RPC stream.
