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
answer up instead, and makes it much less possible to silently answer from the wrong
version's docs.

**Docs:** [Getting the API docs](GETTING-API-DOCS.md) ·
[Troubleshooting](TROUBLESHOOTING.md) · [How it works](HOW-IT-WORKS.md) ·
[Publishing](PUBLISHING.md)

---

## Quick start

There is no npm package: the server is installed straight from this repository,
and the search index comes from the GitHub Releases of this repository.

### Install the CLI

```bash
# npm 12 disables fetching git dependencies by default, hence the opt-in flag
npm install -g --allow-git=all github:kinkirill/bevy_manual_mcp

bevy-mcp fetch-index 0.20.0   # download the prebuilt index (~74 MB)
bevy-mcp status               # show what was auto-detected
bevy-mcp                      # start the stdio server
```

Or clone it yourself, which needs no npm flags at all:

```bash
git clone https://github.com/kinkirill/bevy_manual_mcp
cd bevy_manual_mcp && npm install
./bin/bevy-mcp.js fetch-index 0.20.0
```

### Configure it

`bevy-mcp.config.json` is the whole setup - no environment variables needed. The
minimal version points at your game and lets the server find the docs itself:

```json
{
  "projectRoot": "/path/to/your/bevy/game",
  "websiteDir": "./vendor/bevy-website"
}
```

It reads the Bevy version from `Cargo.lock` and the API from `target/doc`. Since
the index is normally installed rather than built, pinning it explicitly is
usually enough:

```json
{
  "bevyVersion": "0.20.0",
  "websiteDir": "./vendor/bevy-website"
}
```

### Run it

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
(one-time, see [Getting the API docs](GETTING-API-DOCS.md)). Every run after
that reloads from disk in a couple of seconds.

---

## Registering with an MCP client

All of these assume the settings live in `bevy-mcp.config.json`, so the only
thing a client needs is the command. `index.js` takes no arguments.

If your client can spawn the command itself, `npx` works without a global
install; pass the project path, since the Bevy version is read from
`Cargo.lock`:

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
      "command": "node",
      "args": ["/absolute/path/to/bevy-manual-mcp/index.js"],
      "enabled": true,
      "remote": false
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
| `BEVY_ERRORS_DIR` | Explicit `errors/` dir | auto |
| `BEVY_EXTRA_VERSIONS` | Additional versions to hold, e.g. `0.18.1=/path/to/doc,0.17.0=/other` | none |
| `BEVY_MIRROR_DIR` | Where `fetch-docs.mjs` writes downloads | `~/.cache/bevy-mcp/<version>` |
| `BEVY_MCP_CONFIG` | Explicit path to a config file | auto-discovered |
| `BEVY_MCP_DATA_DIR` | Where the persistent index is stored | `<repo>/data` if present, else `~/.cache/bevy-mcp/data` |
| `BEVY_MCP_MAX_RESULTS` | Default result count for search | `8` |
| `BEVY_MCP_REPO` | `owner/repo` used by `fetch-index` to build Release URLs | `kinkirill/bevy_manual_mcp` |
| `BEVY_MCP_FORCE_REINDEX=1` | Rebuild the index even if cached | off |
| `BEVY_MCP_OFFLINE=1` | Never contact crates.io | off |
| `BEVY_MCP_DEBUG=1` | Verbose parse errors | off |

**Version detection order:** `BEVY_VERSION` → `Cargo.lock` → `Cargo.toml` →
unset (server warns loudly, since an unknown version defeats the point).

---

## Getting the API docs

One command, for the version in your `Cargo.lock`:

```bash
bevy-mcp fetch-index 0.20.0
```

That downloads the prebuilt index (~74 MB) and unpacks it into `data/`. Indexes
are published for Bevy **0.15.3, 0.16.1, 0.17.3, 0.18.1, 0.19.1 and 0.20.0**.

To build an index yourself instead - mirroring rustdoc from docs.rs, using your
own `cargo doc`, adding engine examples, and what the build costs - see
**[GETTING-API-DOCS.md](GETTING-API-DOCS.md)**.

---

## Tools

| Tool | Use it for |
|---|---|
| `bevy_api` | Exact symbol lookup → real signature, docs, and the documented `Default` value. **Start here for API questions.** |
| `bevy_api_diff` | Compare a symbol across the versions you name - signature changed, or only its module? |
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
bevy_api_diff    { "symbol": "Sphere", "versions": "0.15.3,0.20.0" }
bevy_search      { "query": "system ordering", "limit": 5 }
bevy_search      { "query": "spawn ui text", "kind": "code_example" }
bevy_examples    { "task": "2d camera", "category": "2d" }
bevy_migration   { "from_version": "0.19", "to_version": "0.20", "topic": "query" }
bevy_check_version { }
```

---

## Example prompts

System prompts that put the tools to use. Drop one into your agent's
instructions, or take it as a starting point:

| File | Purpose |
|---|---|
| [`default_prompt_example.md`](default_prompt_example.md) | Answer Bevy questions accurately for the user's version. |
| [`migration_prompt_example.md`](migration_prompt_example.md) | Full process for a major-version upgrade. |
| [`migration_prompt_short_example.md`](migration_prompt_short_example.md) | Condensed version of the above. |

---

## Distribution and versioning

Releases track Bevy's minor version: the **`v0.20.x` release** answers for any
Bevy `0.20.y`, because patch releases never change the public API. Match the
minor and you are done.

To keep the first run cheap, the pieces are distributed separately:

| Piece | Where | Size |
|---|---|---|
| Server code + bundled Book/migration prose | this repository (`npm install -g --allow-git=all github:…`) | a few MB |
| Prebuilt index for a Bevy minor | GitHub Releases, via `bevy-mcp fetch-index` | ~74 MB |
| rustdoc mirror (only needed to rebuild) | `bevy-mcp fetch-docs` | ~1.6 GB |

The index holds API metadata, documentation strings, migration guides and
examples - not engine source. Maintainers: see [PUBLISHING.md](PUBLISHING.md)
for the release ritual.

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

`bevy_api_diff` answers "did this actually change?" for one symbol. Install the
indexes you want to compare, then **name the versions to compare** - the tool does
not guess, because comparing 0.19.1→0.20.0 when you are really moving 0.15→0.20
would answer a different question than the one you asked:

```bash
bevy-mcp fetch-index 0.19.1
bevy-mcp fetch-index 0.20.0
```

```
bevy_api_diff { "symbol": "Sphere", "versions": "0.15.3,0.20.0" }
```

With exactly two versions installed it compares those two automatically; with more
it asks you to be explicit. There are three possible verdicts:

- the **signature changed** - the call site will not compile;
- the signature is unchanged but the item **moved between modules** - the `use`
  will not resolve even though the call looks the same;
- identical in both place and signature - nothing to do.

Instead of a Release asset you can add a doc tree you built yourself, with
`BEVY_EXTRA_VERSIONS="0.18.1=/path/to/0.18.1/target/doc"`.

Signatures are whitespace-normalised before comparison, because rustdoc wraps
them differently between builds and a line-break difference is not an API change.
Asking about a version that is **not** indexed returns an error rather than
silently answering from another version - substituting a different version's
API is exactly the confusion pinning exists to prevent.

---

## Troubleshooting

Common problems - empty index, unknown version, missing examples, npm's
`EALLOWGIT`, an ambiguous comparison, or a client that has not picked up a newly
installed version - are covered in **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

---

## Further reading

| Document | Contents |
|---|---|
| [GETTING-API-DOCS.md](GETTING-API-DOCS.md) | Installing a prebuilt index, mirroring docs.rs, `cargo doc`, build cost. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | What to do when something is empty, stale, ambiguous or missing. |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Ranking and design decisions, repository layout, running the tests. |
| [PUBLISHING.md](PUBLISHING.md) | Maintainer checklist for a new Bevy minor. |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | Licences of the bundled and derived content. |
