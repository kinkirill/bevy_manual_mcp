/**
 * Central configuration + version detection.
 *
 * Everything the MCP reads is resolved here so the rest of the code never
 * touches process.env or path guessing. Every path can be overridden with an
 * environment variable, which makes the server testable and usable from any
 * host project.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const env = process.env;

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Optional JSON config file, so a deployment does not have to thread a dozen
 * environment variables through an MCP client config.
 *
 * Search order (first hit wins):
 *   1. BEVY_MCP_CONFIG=/path/to/config.json
 *   2. <projectRoot>/bevy-mcp.config.json
 *   3. <repo>/bevy-mcp.config.json
 *   4. ~/.config/bevy-mcp/config.json
 *
 * Environment variables always win over the file, so a one-off override still
 * works without editing it. Relative paths inside the file resolve against the
 * file's own directory, not the (unpredictable) process cwd.
 */
function loadConfigFile(projectRootHint) {
  const candidates = [
    env.BEVY_MCP_CONFIG,
    projectRootHint && path.join(projectRootHint, "bevy-mcp.config.json"),
    path.join(REPO_ROOT, "bevy-mcp.config.json"),
    path.join(os.homedir(), ".config", "bevy-mcp", "config.json"),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      log(`config: loaded ${file}`);
      return {
        path: path.resolve(file),
        data: data && typeof data === "object" ? data : {},
      };
    } catch (err) {
      log(`config: ignoring ${file} (${err.message})`);
    }
  }
  return { path: null, data: {} };
}

function expandHome(p) {
  const s = String(p);
  return s === "~" || s.startsWith("~/") ? path.join(os.homedir(), s.slice(1)) : s;
}

/** Resolve a config-file path relative to that file, and expand `~`. */
function resolveConfigPath(p, configDir) {
  if (!p) return undefined;
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

/** Read `name = "version"` or `name = { version = "x" }` out of a Cargo.toml. */
function readCargoTomlVersion(text, crateName) {
  // Find the [dependencies] / [dev-dependencies] / [build-dependencies] tables
  // and look for the crate inside them, so a `[package] name = "bevy"` in an
  // unrelated section cannot produce a false positive.
  const tableRe =
    /^\s*\[\s*(?:[^\]]*\.)?(?:dev-|build-)?dependencies\s*\]/gim;
  let match;
  let fallback = null;

  while ((match = tableRe.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    const end = rest.search(/^\s*\[/m);
    const table = end === -1 ? rest : rest.slice(0, end);

    const escaped = crateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entryRe = new RegExp(
      `^\\s*(?:${escaped}\\s*=|"${escaped}"\\s*=)` +
        `[\\s\\S]{0,200}?version\\s*=\\s*"([^"]+)"`,
      "m",
    );
    const found = table.match(entryRe);
    if (found) {
      fallback = found[1];
      // An exact table version wins over a workspace-level default.
      if (new RegExp(`^\\s*(?:${escaped}\\s*=|"${escaped}"\\s*=)\\s*\\{`).test(table)) {
        return found[1];
      }
    }
  }
  return fallback;
}

/**
 * Resolve the Bevy version to index.
 *
 * Priority:
 *   1. BEVY_VERSION env var (explicit override)
 *   2. Cargo.lock in the host project  <- authoritative, this is what compiles
 *   3. Cargo.toml in the host project   <- requested range, not exact
 *   4. version file next to the MCP
 */
export function detectBevyVersion(projectRoot, explicit = null) {
  if (explicit) return { version: explicit.version, source: explicit.source };

  const fromEnv = pick(env.BEVY_VERSION);
  if (fromEnv) return { version: fromEnv, source: "BEVY_VERSION env var" };

  const lockPath = path.join(projectRoot, "Cargo.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const lock = fs.readFileSync(lockPath, "utf8");
      // Cargo.lock v3/v4 format: [[package]] name = "bevy" ... version = "x.y.z"
      const blocks = lock.split(/\[\[package\]\]/);
      for (const block of blocks) {
        if (/^\s*name\s*=\s*"bevy"\s*$/m.test(block)) {
          const v = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
          if (v) return { version: v[1], source: lockPath };
        }
      }
    } catch {
      /* fall through */
    }
  }

  const tomlPath = path.join(projectRoot, "Cargo.toml");
  if (fs.existsSync(tomlPath)) {
    try {
      const v = readCargoTomlVersion(
        fs.readFileSync(tomlPath, "utf8"),
        "bevy",
      );
      if (v) return { version: v, source: tomlPath + " (requested range)" };
    } catch {
      /* fall through */
    }
  }

  return {
    version: null,
    source: null,
    note:
      "Could not determine the Bevy version. Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at a Cargo project.",
  };
}

/**
 * Locate a cargo target/doc directory that holds rustdoc output for `crate`.
 * Handles both `target/` and `target/<triple>/` layouts.
 */
function findDocRoot(projectRoot, override) {
  const candidates = [];
  const target = path.join(projectRoot, "target");
  const chosen = pick(env.BEVY_DOC_DIR, override);
  if (chosen) candidates.push(chosen);

  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target)) {
      const p = path.join(target, entry);
      if (!fs.statSync(p).isDirectory()) continue;
      if (entry === "doc" || entry === ".rustc_info.json") continue;
      candidates.push(path.join(p, "doc"));
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.readdirSync(c).length > 0) return c;
  }
  return null;
}

/**
 * Determine which Bevy version the rustdoc on disk was actually built from.
 *
 * This is independent of what the host project asks for, which lets us catch
 * the failure mode that matters most: pointing BEVY_DOC_DIR at the wrong
 * version's docs while confidently reporting the right one.
 *
 * Sources, in order:
 *   1. `.bevy-mcp-docversion.json` written by scripts/fetch-docs.mjs
 *   2. `.lock` written by rustdoc itself (JSON map of crate -> version)
 */
export function detectDocVersion(docDir) {
  if (!docDir) return null;

  const manifest = path.join(docDir, ".bevy-mcp-docversion.json");
  if (fs.existsSync(manifest)) {
    try {
      const j = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (j.version) {
        return { version: j.version, source: manifest };
      }
    } catch {
      /* fall through */
    }
  }

  // rustdoc writes a Cargo.lock-shaped file next to the generated HTML.
  const lock = path.join(docDir, ".lock");
  if (fs.existsSync(lock)) {
    try {
      const raw = fs.readFileSync(lock, "utf8").trim();
      if (!raw) return null;
      const j = JSON.parse(raw);
      const versions = Array.isArray(j)
        ? Object.fromEntries(
            j.map((e) => [e.name, e.version]).filter(([n]) => n),
          )
        : j;
      const v = versions.bevy ?? versions["bevy"];
      if (typeof v === "string") return { version: v, source: lock };
    } catch {
      /* not JSON, or an unexpected shape */
    }
  }
  return null;
}

function firstExistingDir(...paths) {
  for (const p of paths) {
    if (!p) continue;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

export function resolveConfig() {
  // Provisional project root, used only to locate a project-local config file.
  const projectRootHint = path.resolve(
    pick(env.BEVY_PROJECT_ROOT, env.INIT_CWD, process.cwd()),
  );
  const { path: configPath, data: file } = loadConfigFile(projectRootHint);
  const configDir = configPath ? path.dirname(configPath) : projectRootHint;
  const fromFile = (key) => resolveConfigPath(file[key], configDir);

  // The host project: where the user's Bevy code actually lives.
  // Precedence for every setting below is: env var > config file > auto-detect.
  const projectRoot = path.resolve(
    pick(env.BEVY_PROJECT_ROOT, fromFile("projectRoot"), env.INIT_CWD, process.cwd()),
  );

  const fileVersion = pick(file.bevyVersion, file.version);
  const explicitVersion = pick(env.BEVY_VERSION)
    ? { version: pick(env.BEVY_VERSION), source: "BEVY_VERSION env var" }
    : fileVersion
      ? { version: String(fileVersion), source: `config file (${configPath})` }
      : null;
  const { version, source, note } = detectBevyVersion(projectRoot, explicitVersion);

  const docDir = findDocRoot(projectRoot, fromFile("docDir"));
  const docVersion = detectDocVersion(docDir);

  const bevySrcDir = firstExistingDir(
    env.BEVY_SRC_DIR,
    fromFile("bevySrcDir"),
    version && path.join(projectRoot, `bevy-src-v${version}`, "examples")
      ? path.join(projectRoot, `bevy-src-v${version}`)
      : null,
    path.join(projectRoot, "bevy"),
  );
  const websiteDir = firstExistingDir(
    env.BEVY_WEBSITE_DIR,
    fromFile("websiteDir"),
    path.join(REPO_ROOT, "vendor", "bevy-website"),
    path.join(REPO_ROOT, "bevy-website"),
    path.join(os.homedir(), "bevy-website"),
  );
  const examplesDir = firstExistingDir(
    env.BEVY_EXAMPLES_DIR,
    fromFile("examplesDir"),
    bevySrcDir && path.join(bevySrcDir, "examples"),
    path.join(projectRoot, `bevy-src-v${version}`, "examples"),
    path.join(projectRoot, "bevy", "examples"),
  );
  const errorsDir = firstExistingDir(
    env.BEVY_ERRORS_DIR,
    fromFile("errorsDir"),
    bevySrcDir && path.join(bevySrcDir, "errors"),
  );

  const mirrorDir =
    pick(env.BEVY_MIRROR_DIR, fromFile("mirrorDir")) ||
    path.join(os.homedir(), ".cache", "bevy-mcp", version || "unversioned");

  // A source checkout keeps its index in ./data; a package installed from npm
  // (npx) lives in a read-only, ephemeral node_modules tree, so fall back to a
  // per-user cache directory that survives between runs.
  const repoDataDir = path.join(REPO_ROOT, "data");
  const dataDir =
    pick(env.BEVY_MCP_DATA_DIR, fromFile("dataDir")) ||
    (fs.existsSync(repoDataDir)
      ? repoDataDir
      : path.join(os.homedir(), ".cache", "bevy-mcp", "data"));

  return {
    projectRoot,
    bevyVersion: version,
    versionSource: source,
    versionNote: note,
    configPath,
    docVersion: docVersion?.version || null,
    docVersionSource: docVersion?.source || null,
    docDir,
    websiteDir,
    examplesDir,
    bevySrcDir,
    errorsDir,
    mirrorDir,
    dataDir,
    env: {
      offline:
        env.BEVY_MCP_OFFLINE !== undefined
          ? env.BEVY_MCP_OFFLINE === "1"
          : !!file.offline,
      maxResults:
        env.BEVY_MCP_MAX_RESULTS !== undefined
          ? Number(env.BEVY_MCP_MAX_RESULTS)
          : Number(file.maxResults ?? 8),
      debug:
        env.BEVY_MCP_DEBUG !== undefined ? env.BEVY_MCP_DEBUG === "1" : !!file.debug,
    },
  };
}

export function log(...args) {
  console.error("[bevy-mcp]", ...args);
}