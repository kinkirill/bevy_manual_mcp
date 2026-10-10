/** Configuration and source discovery shared by the server and command-line tools. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { errorMessage, isObject, parseJson, type ResolvedConfig } from "./types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_ROOT = path.dirname(MODULE_DIR);
export const PACKAGE_ROOT = fs.existsSync(path.join(RUNTIME_ROOT, "package.json"))
  ? RUNTIME_ROOT : path.dirname(RUNTIME_ROOT);
export const REPO_ROOT = PACKAGE_ROOT;
function pick(...values: (string | null | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? undefined;
}
const configSchema = z.object({
  projectRoot: z.string().optional(), bevyVersion: z.string().optional(), version: z.string().optional(),
  docDir: z.string().optional(), bevySrcDir: z.string().optional(), websiteDir: z.string().optional(),
  examplesDir: z.string().optional(), errorsDir: z.string().optional(), mirrorDir: z.string().optional(),
  dataDir: z.string().optional(), offline: z.boolean().optional(), debug: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
});
type ConfigFile = z.infer<typeof configSchema>;
function loadConfigFile(projectRoot: string, env: NodeJS.ProcessEnv): { path: string | null; data: ConfigFile } {
  const candidates = [env.BEVY_MCP_CONFIG, path.join(projectRoot, "bevy-mcp.config.json"),
    path.join(PACKAGE_ROOT, "bevy-mcp.config.json"), path.join(os.homedir(), ".config", "bevy-mcp", "config.json")];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const data = configSchema.parse(parseJson(fs.readFileSync(file, "utf8")));
      log(`config: loaded ${file}`);
      return { path: path.resolve(file), data };
    } catch (error) { log(`config: ignoring ${file} (${errorMessage(error)})`); }
  }
  return { path: null, data: {} };
}
function expandHome(value: string): string {
  return value === "~" || /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
}
function resolveConfigPath(value: string | undefined, configDir: string): string | undefined {
  if (!value) return undefined;
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

/** Parse actual TOML entries so adjacent dependencies cannot supply Bevy's version. */
export function readCargoTomlVersion(text: string, crateName: string): string | null {
  const parsed: unknown = parseToml(text);
  if (!isObject(parsed)) return null;
  const workspace = isObject(parsed.workspace) ? parsed.workspace : {};
  const workspaceDependencies = isObject(workspace.dependencies) ? workspace.dependencies : {};
  const tables: unknown[] = [parsed.dependencies, parsed["dev-dependencies"], parsed["build-dependencies"]];
  if (isObject(parsed.target)) for (const target of Object.values(parsed.target)) {
    if (isObject(target)) tables.push(target.dependencies, target["dev-dependencies"], target["build-dependencies"]);
  }
  for (const table of tables) {
    if (!isObject(table)) continue;
    for (const [name, entry] of Object.entries(table)) {
      if (name !== crateName && !(isObject(entry) && entry.package === crateName)) continue;
      if (typeof entry === "string") return entry;
      if (!isObject(entry)) continue;
      if (typeof entry.version === "string") return entry.version;
      if (entry.workspace === true) {
        const inherited = workspaceDependencies[name];
        if (typeof inherited === "string") return inherited;
        if (isObject(inherited) && typeof inherited.version === "string") return inherited.version;
      }
    }
  }
  const workspaceEntry = workspaceDependencies[crateName];
  return typeof workspaceEntry === "string" ? workspaceEntry
    : isObject(workspaceEntry) && typeof workspaceEntry.version === "string" ? workspaceEntry.version : null;
}

export interface DetectedVersion { version: string | null; source: string | null; note?: string }
export function detectBevyVersion(
  projectRoot: string, explicit: DetectedVersion | null = null, env: NodeJS.ProcessEnv = process.env,
): DetectedVersion {
  if (explicit) return explicit;
  if (env.BEVY_VERSION) return { version: env.BEVY_VERSION, source: "BEVY_VERSION env var" };
  // Cargo workspaces keep their lockfile at the workspace root.
  let directory = projectRoot;
  while (true) {
    const lockPath = path.join(directory, "Cargo.lock");
    if (fs.existsSync(lockPath)) {
      try {
        const parsed: unknown = parseToml(fs.readFileSync(lockPath, "utf8"));
        if (isObject(parsed) && Array.isArray(parsed.package)) {
          const pkg: unknown = parsed.package.find((entry: unknown) => isObject(entry) && entry.name === "bevy");
          if (isObject(pkg) && typeof pkg.version === "string") return { version: pkg.version, source: lockPath };
        }
      } catch { /* Try the manifest if a lockfile cannot be read. */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  directory = projectRoot;
  while (true) {
    const tomlPath = path.join(directory, "Cargo.toml");
    if (fs.existsSync(tomlPath)) {
      try {
        const version = readCargoTomlVersion(fs.readFileSync(tomlPath, "utf8"), "bevy");
        if (version) return { version, source: `${tomlPath} (requested range)` };
      } catch { /* Invalid or inaccessible manifests are not version sources. */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { version: null, source: null,
    note: "Could not determine the Bevy version. Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at a Cargo project." };
}
function firstExistingDir(...paths: (string | null | undefined)[]): string | null {
  for (const candidate of paths) {
    if (!candidate) continue;
    try { if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate); } catch { }
  }
  return null;
}
export function findDocRoot(projectRoot: string, override?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const target = path.join(projectRoot, "target");
  const candidates: (string | undefined)[] = [pick(env.BEVY_DOC_DIR, override), path.join(target, "doc")];
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "doc") candidates.push(path.join(target, entry.name, "doc"));
    }
  } catch { }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { if (fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate).length) return path.resolve(candidate); }
    catch { }
  }
  return null;
}
export function detectDocVersion(docDir: string | null): { version: string; source: string } | null {
  if (!docDir) return null;
  for (const filename of [".bevy-mcp-docversion.json", ".lock"]) {
    const file = path.join(docDir, filename);
    try {
      const parsed = parseJson(fs.readFileSync(file, "utf8"));
      if (filename === ".bevy-mcp-docversion.json" && isObject(parsed) && typeof parsed.version === "string") {
        return { version: parsed.version, source: file };
      }
      if (Array.isArray(parsed)) {
        const entry: unknown = parsed.find((item: unknown) => isObject(item) && item.name === "bevy");
        if (isObject(entry) && typeof entry.version === "string") return { version: entry.version, source: file };
      } else if (isObject(parsed) && typeof parsed.bevy === "string") return { version: parsed.bevy, source: file };
    } catch { /* Try the next version marker. */ }
  }
  return null;
}

export interface ResolveConfigOptions { env?: NodeJS.ProcessEnv; projectRoot?: string; bevyVersion?: string }
export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const projectRootHint = path.resolve(pick(options.projectRoot, env.BEVY_PROJECT_ROOT, env.INIT_CWD, process.cwd()) ?? process.cwd());
  const { path: configPath, data: file } = loadConfigFile(projectRootHint, env);
  const configDir = configPath ? path.dirname(configPath) : projectRootHint;
  const fromFile = (key: keyof ConfigFile): string | undefined => {
    const value = file[key];
    return typeof value === "string" ? resolveConfigPath(value, configDir) : undefined;
  };
  const projectRoot = path.resolve(pick(options.projectRoot, env.BEVY_PROJECT_ROOT, fromFile("projectRoot"), env.INIT_CWD, process.cwd()) ?? process.cwd());
  const versionOverride = pick(options.bevyVersion, env.BEVY_VERSION, file.bevyVersion, file.version);
  const explicit: DetectedVersion | null = versionOverride ? { version: versionOverride,
    source: options.bevyVersion ? "command-line version" : env.BEVY_VERSION ? "BEVY_VERSION env var" : `config file (${configPath})` } : null;
  const detected = detectBevyVersion(projectRoot, explicit, env);
  const version = detected.version;
  const docDir = findDocRoot(projectRoot, fromFile("docDir"), env);
  const docVersion = detectDocVersion(docDir);
  const bevySrcDir = firstExistingDir(env.BEVY_SRC_DIR, fromFile("bevySrcDir"),
    version ? path.join(projectRoot, `bevy-src-v${version}`) : null, path.join(projectRoot, "bevy"));
  const websiteDir = firstExistingDir(env.BEVY_WEBSITE_DIR, fromFile("websiteDir"),
    path.join(PACKAGE_ROOT, "vendor", "bevy-website"), path.join(PACKAGE_ROOT, "bevy-website"), path.join(os.homedir(), "bevy-website"));
  const examplesDir = firstExistingDir(env.BEVY_EXAMPLES_DIR, fromFile("examplesDir"), bevySrcDir ? path.join(bevySrcDir, "examples") : null);
  const errorsDir = firstExistingDir(env.BEVY_ERRORS_DIR, fromFile("errorsDir"), bevySrcDir ? path.join(bevySrcDir, "errors") : null);
  const mirrorDir = pick(env.BEVY_MIRROR_DIR, fromFile("mirrorDir")) ?? path.join(os.homedir(), ".cache", "bevy-mcp", version ?? "unversioned");
  const repoDataDir = path.join(PACKAGE_ROOT, "data");
  const dataDir = pick(env.BEVY_MCP_DATA_DIR, fromFile("dataDir")) ?? (fs.existsSync(repoDataDir) ? repoDataDir : path.join(os.homedir(), ".cache", "bevy-mcp", "data"));
  const maxResults = Number(env.BEVY_MCP_MAX_RESULTS ?? file.maxResults ?? 8);
  return { projectRoot, bevyVersion: version, versionSource: detected.source, versionNote: detected.note,
    configPath, docVersion: docVersion?.version ?? null, docVersionSource: docVersion?.source ?? null,
    docDir, websiteDir, examplesDir, bevySrcDir, errorsDir, mirrorDir, dataDir,
    env: { offline: env.BEVY_MCP_OFFLINE !== undefined ? env.BEVY_MCP_OFFLINE === "1" : file.offline ?? false,
      debug: env.BEVY_MCP_DEBUG !== undefined ? env.BEVY_MCP_DEBUG === "1" : file.debug ?? false,
      maxResults: Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= 20 ? maxResults : 8 } };
}
export function log(...args: unknown[]): void { console.error("[bevy-mcp]", ...args); }
