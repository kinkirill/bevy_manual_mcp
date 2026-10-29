/**
 * Project feature resolution for `bevy_check_manifest`.
 *
 * Cargo's own resolved metadata is the source of truth when it can be obtained
 * cheaply and offline (`cargo metadata --offline --locked`). When that is not
 * possible the manifest is analysed directly, which is deliberately labelled a
 * *partial* result: the absence of a `default-features = false` declaration is
 * never treated as proof that defaults are disabled.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { isObject, parseJson, type ResolvedConfig } from "../types.js";
import type { FeaturesData } from "./features.js";

export interface ManifestAnalysis {
  /** Where the feature set came from. */
  source: "cargo-metadata" | "toml" | "none";
  /** True when the answer may be incomplete (no Cargo resolution, no manifest…). */
  partial: boolean;
  manifest_path: string | null;
  /** The dependency table(s) that named Bevy. */
  dependency_forms: string[];
  /** Bevy dependency present in the manifest. */
  has_bevy_dependency: boolean;
  /** Default features are on unless every Bevy declaration disables them. */
  default_features_enabled: boolean;
  /** Features the manifest asks for (inherited features included). */
  explicit: string[];
  /** Explicit + default-profile + transitive feature closure. */
  transitive: string[];
  warning?: string;
}

const EMPTY: ManifestAnalysis = {
  source: "none", partial: true, manifest_path: null, dependency_forms: [],
  has_bevy_dependency: false, default_features_enabled: true, explicit: [], transitive: [],
  warning: "No Cargo.toml was found for the project root.",
};

/** Nearest Cargo.toml at or above `start`. */
function findManifest(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    const candidate = path.join(directory, "Cargo.toml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Nearest Cargo.toml above `start` that declares a `[workspace]` table. */
function findWorkspaceManifest(start: string): string | null {
  let directory = path.resolve(start);
  for (;;) {
    const candidate = path.join(directory, "Cargo.toml");
    try {
      const parsed: unknown = parseToml(fs.readFileSync(candidate, "utf8"));
      if (isObject(parsed) && isObject(parsed.workspace)) return candidate;
    } catch { /* keep walking */ }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function dependencyTables(parsed: Record<string, unknown>): { name: string; table: Record<string, unknown> }[] {
  const tables: { name: string; table: Record<string, unknown> }[] = [];
  for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    if (isObject(parsed[name])) tables.push({ name, table: parsed[name] });
  }
  if (isObject(parsed.target)) {
    for (const [target, value] of Object.entries(parsed.target)) {
      if (!isObject(value)) continue;
      for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
        if (isObject(value[name])) tables.push({ name: `target.${target}.${name}`, table: value[name] });
      }
    }
  }
  return tables;
}

interface BevyDependency {
  form: string;
  features: string[];
  defaultsOn: boolean;
  workspace: boolean;
  /** The key used to look up `[workspace.dependencies]`. */
  packageKey: string;
}

function readBevyDependencies(parsed: Record<string, unknown>): BevyDependency[] {
  const found: BevyDependency[] = [];
  for (const { name, table } of dependencyTables(parsed)) {
    for (const [key, raw] of Object.entries(table)) {
      const entry = raw;
      const isBevy = key === "bevy" || (isObject(entry) && entry.package === "bevy");
      if (!isBevy) continue;
      if (typeof entry === "string") {
        found.push({ form: name, features: [], defaultsOn: true, workspace: false, packageKey: key });
        continue;
      }
      if (!isObject(entry)) continue;
      const features = Array.isArray(entry.features)
        ? entry.features.filter((f): f is string => typeof f === "string")
        : [];
      const defaultsOn = entry["default-features"] !== false;
      found.push({
        form: name, features, defaultsOn,
        workspace: entry.workspace === true, packageKey: key,
      });
    }
  }
  return found;
}

function workspaceDependencyFeatures(workspaceManifest: string | null, key: string): { features: string[]; defaultsOn: boolean; found: boolean } {
  if (!workspaceManifest) return { features: [], defaultsOn: true, found: false };
  try {
    const parsed: unknown = parseToml(fs.readFileSync(workspaceManifest, "utf8"));
    if (!isObject(parsed) || !isObject(parsed.workspace) || !isObject(parsed.workspace.dependencies)) {
      return { features: [], defaultsOn: true, found: false };
    }
    const entry = parsed.workspace.dependencies[key] ?? parsed.workspace.dependencies.bevy;
    if (typeof entry === "string") return { features: [], defaultsOn: true, found: true };
    if (!isObject(entry)) return { features: [], defaultsOn: true, found: false };
    const features = Array.isArray(entry.features)
      ? entry.features.filter((f): f is string => typeof f === "string")
      : [];
    return { features, defaultsOn: entry["default-features"] !== false, found: true };
  } catch {
    return { features: [], defaultsOn: true, found: false };
  }
}

/** Expand profiles, then walk the vendored closure, so availability checks see
 *  the same set Cargo would enable. */
export function expandFeatures(requested: string[], data: FeaturesData | null): string[] {
  const enabled = new Set(requested);
  if (!data) return [...enabled].sort();

  for (const name of [...enabled]) {
    const profile = data.profiles?.[name];
    if (profile) for (const feature of profile.enables) enabled.add(feature);
  }
  const closure = data.closure ?? {};
  const queue = [...enabled];
  while (queue.length) {
    const feature = queue.pop()!;
    const next: string[] = closure[feature] ?? data.features[feature] ?? [];
    for (const name of next) {
      if (enabled.has(name)) continue;
      enabled.add(name);
      queue.push(name);
    }
  }
  return [...enabled].sort();
}

/**
 * Analyse the project's manifests when Cargo resolution is unavailable. Handles
 * `default-features`, dependency aliases, `workspace = true` inheritance and
 * target-specific tables.
 */
export function analyzeToml(projectRoot: string, data: FeaturesData | null): ManifestAnalysis {
  const manifestPath = findManifest(projectRoot);
  if (!manifestPath) return { ...EMPTY };

  let parsed: Record<string, unknown>;
  try {
    const raw: unknown = parseToml(fs.readFileSync(manifestPath, "utf8"));
    if (!isObject(raw)) return { ...EMPTY, manifest_path: manifestPath, warning: "Cargo.toml did not parse as a table." };
    parsed = raw;
  } catch (error) {
    return {
      ...EMPTY, manifest_path: manifestPath,
      warning: `Cargo.toml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const dependencies = readBevyDependencies(parsed);
  const workspaceManifest = findWorkspaceManifest(path.dirname(manifestPath));
  const explicit = new Set<string>();
  const forms = new Set<string>();
  let hasBevy = dependencies.length > 0;
  let defaultsOn = false;

  for (const dependency of dependencies) {
    forms.add(dependency.form);
    let features = dependency.features;
    let defaults = dependency.defaultsOn;
    if (dependency.workspace) {
      const inherited = workspaceDependencyFeatures(workspaceManifest, dependency.packageKey);
      if (inherited.found) {
        features = [...features, ...inherited.features];
        // A member's explicit `default-features` wins; otherwise inherit.
        if (!declaresDefaultFeatures(parsed, dependency)) defaults = inherited.defaultsOn;
      }
    }
    for (const feature of features) explicit.add(feature);
    if (defaults) defaultsOn = true;
  }

  // A virtual workspace root has no `[dependencies]`, only inherited ones.
  if (!hasBevy) {
    const inherited = workspaceDependencyFeatures(workspaceManifest, "bevy");
    if (inherited.found) {
      hasBevy = true;
      forms.add("workspace.dependencies");
      for (const feature of inherited.features) explicit.add(feature);
      if (inherited.defaultsOn) defaultsOn = true;
    }
  }

  // Defaults are on unless every Bevy declaration disables them. With no Bevy
  // dependency at all we still do not claim defaults are off.
  const defaultFeaturesEnabled = hasBevy ? defaultsOn : true;
  const requested = [...explicit];
  if (defaultFeaturesEnabled && data?.default_features) requested.push(...data.default_features);

  return {
    source: "toml",
    partial: true,
    manifest_path: manifestPath,
    dependency_forms: [...forms],
    has_bevy_dependency: hasBevy,
    default_features_enabled: defaultFeaturesEnabled,
    explicit: [...explicit].sort(),
    transitive: expandFeatures(requested, data),
    warning: hasBevy ? "Cargo resolution was unavailable; features were read from Cargo.toml (partial)."
      : "No Bevy dependency was found in the nearest Cargo.toml.",
  };
}

/** Whether this dependency entry explicitly sets `default-features`. */
function declaresDefaultFeatures(parsed: Record<string, unknown>, dependency: BevyDependency): boolean {
  for (const { name, table } of dependencyTables(parsed)) {
    if (name !== dependency.form) continue;
    const entry = table[dependency.packageKey];
    if (isObject(entry) && "default-features" in entry) return true;
  }
  return false;
}

const cargoMetadataSchema = z.object({
  packages: z.array(z.object({ id: z.string(), name: z.string(), version: z.string() })),
  resolve: z.object({
    nodes: z.array(z.object({ id: z.string(), features: z.array(z.string()) })),
  }).nullable(),
}).passthrough();

/**
 * Run `cargo metadata` offline with a hard timeout. Returns null on any failure
 * so the caller can fall back to the labelled partial analysis.
 */
export function cargoMetadataFeatures(projectRoot: string, bevyVersion: string | null, timeoutMs = 10_000): ManifestAnalysis | null {
  if (process.env.BEVY_MCP_CARGO_METADATA === "0") return null;
  if (!findManifest(projectRoot)) return null;
  try {
    const output = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--offline", "--locked"],
      { cwd: projectRoot, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const parsed = cargoMetadataSchema.safeParse(parseJson(output.toString("utf8")));
    if (!parsed.success) return null;
    const metadata = parsed.data;
    if (!metadata.resolve) return null;
    const bevyPackages = metadata.packages.filter((pkg) => pkg.name === "bevy");
    if (!bevyPackages.length) return null;
    const preferred = (bevyVersion && bevyPackages.find((pkg) => pkg.version === bevyVersion)) || bevyPackages[0]!;
    const node = metadata.resolve.nodes.find((candidate) => candidate.id === preferred.id);
    if (!node) return null;
    const features = [...new Set(node.features)].sort();
    return {
      source: "cargo-metadata",
      partial: false,
      manifest_path: findManifest(projectRoot),
      dependency_forms: ["cargo-metadata"],
      has_bevy_dependency: true,
      default_features_enabled: features.includes("default"),
      explicit: features,
      transitive: features,
    };
  } catch {
    return null;
  }
}

/** Cargo metadata when it succeeds, otherwise the labelled TOML analysis. */
export function analyzeManifest(config: ResolvedConfig, data: FeaturesData | null): ManifestAnalysis {
  return cargoMetadataFeatures(config.projectRoot, config.bevyVersion)
    ?? analyzeToml(config.projectRoot, data);
}
