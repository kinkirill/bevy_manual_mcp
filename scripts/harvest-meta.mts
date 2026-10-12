#!/usr/bin/env node
/** Harvest per-version Bevy metadata from the bevy repo at an exact git tag. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { errorMessage, isObject, stableVersion, stringOption, versionArgs } from "./cli-utils.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Compiled scripts live at build/scripts/, so go up two levels for the repo root.
const ROOT = path.resolve(HERE, "..", "..");
const REPO = "bevyengine/bevy";
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const API = `https://api.github.com/repos/${REPO}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string, tries = 4): Promise<string | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "bevy-mcp/harvest-meta", Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === tries) {
        console.error(`  ! network error ${url}: ${errorMessage(err)}`);
        return null;
      }
      await sleep(500 * attempt + Math.random() * 400);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === tries) {
        console.error(`  ! gave up on ${url} (HTTP ${res.status})`);
        return null;
      }
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(retryAfter * 1000 || Math.min(30000, 1000 * 2 ** (attempt - 1)));
      continue;
    }
    if (!res.ok) {
      console.error(`  ! HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  }
  return null;
}

/** Resolve a feature entry to the set of top-level features it enables. */
function resolveEntry(entry: string, allFeatures: Set<string>): string[] {
  const slash = entry.indexOf("/");
  const base = slash === -1 ? entry : entry.slice(0, slash);
  const feat = base.startsWith("dep:") ? base.slice(4) : base;
  return allFeatures.has(feat) ? [feat] : [];
}

/** Transitive closure of the feature graph. */
function closure(features: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of Object.keys(features)) {
    const seen = new Set<string>();
    const stack = [...(features[name] ?? [])];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const next of features[f] ?? []) stack.push(next);
    }
    seen.delete(name);
    out[name] = [...seen].sort();
  }
  return out;
}

/** Extract `#[cfg(feature = "X")]` gates and the following plugin path. */
function pluginGates(src: string): Array<{ plugin: string; requires_feature: string }> {
  const gates: Array<{ plugin: string; requires_feature: string }> = [];
  const re = /#\[cfg\(feature\s*=\s*"([^"]+)"\)\]\s*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*[a-z_:]+:::([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    gates.push({ plugin: m[2]!, requires_feature: m[1]! });
  }
  return gates;
}

async function main() {
  const { version: argVersion, values } = versionArgs(process.argv.slice(2), {
    out: { type: "string" },
    tag: { type: "string" },
    force: { type: "boolean" },
  });
  if (!argVersion) throw new Error("Usage: node scripts/harvest-meta.mjs <version> [--tag <tag>] [--out <dir>]");
  const version = stableVersion(argVersion);
  const tag = stringOption(values.tag) ?? `v${version}`;
  const outArg = stringOption(values.out) ?? path.join(ROOT, "vendor", "bevy-meta", version);
  const outRoot = path.resolve(outArg);

  const dest = (rel: string) => path.join(outRoot, rel);
  if (fs.existsSync(path.join(outRoot, "meta.json")) && !values.force) {
    console.log(`Already harvested ${version} at ${outRoot}. Use --force to replace.`);
    return;
  }

  console.log(`Harvesting Bevy ${version} from tag ${tag}`);
  console.log(`  repo:   ${REPO}`);
  console.log(`  target: ${outRoot}\n`);

  fs.mkdirSync(dest("error-codes"), { recursive: true });

  // ---- Error codes -------------------------------------------------------
  console.log("Fetching error codes…");
  const listJson = await fetchText(`${API}/contents/errors?ref=${tag}`);
  if (!listJson) throw new Error(`Could not list errors/ at tag ${tag}.`);
  const list = JSON.parse(listJson) as Array<{ name: string; type: string }>;
  const codeFiles = list.filter((e) => /^B\d{4}\.md$/.test(e.name) && e.type === "file");

  let codesWritten = 0;
  for (const entry of codeFiles) {
    const body = await fetchText(`${RAW}/${tag}/errors/${entry.name}`);
    if (body === null) {
      console.error(`  ! failed to fetch ${entry.name}`);
      continue;
    }
    fs.writeFileSync(dest(`error-codes/${entry.name}`), body);
    codesWritten++;
  }
  console.log(`  error codes: ${codesWritten}/${codeFiles.length}`);

  // ---- Feature graph -----------------------------------------------------
  console.log("Fetching feature graph…");
  const internalToml = await fetchText(`${RAW}/${tag}/crates/bevy_internal/Cargo.toml`);
  if (!internalToml) throw new Error("Could not fetch bevy_internal/Cargo.toml.");
  const internal = parseToml(internalToml) as { features?: Record<string, unknown> };
  const rawFeatures = isObject(internal.features) ? internal.features : {};

  const featureNames = new Set(Object.keys(rawFeatures));
  const graph: Record<string, string[]> = {};
  for (const [name, val] of Object.entries(rawFeatures)) {
    if (!Array.isArray(val)) continue;
    const enables = new Set<string>();
    for (const entry of val) {
      if (typeof entry !== "string") continue;
      for (const f of resolveEntry(entry, featureNames)) enables.add(f);
    }
    graph[name] = [...enables].sort();
  }

  // Profiles and default features live in the facade Cargo.toml.
  // Only the four well-known profiles are captured; other facade features
  // (default_app, common_api, …) are part of the graph, not profiles.
  const PROFILE_NAMES = new Set(["2d", "3d", "ui", "audio"]);
  const facadeToml = await fetchText(`${RAW}/${tag}/Cargo.toml`);
  const profiles: Record<string, { description: string; enables: string[] }> = {};
  let defaultFeatures: string[] = [];
  if (facadeToml) {
    const facade = parseToml(facadeToml) as { features?: Record<string, unknown> };
    const facadeFeatures = isObject(facade.features) ? facade.features : {};
    for (const [name, val] of Object.entries(facadeFeatures)) {
      if (!Array.isArray(val)) continue;
      // Facade-level entries (2d, 3d, ui, audio, default) are captured verbatim;
      // their enables reference other facade-level names, not bevy_internal features.
      const enables = val.filter((e): e is string => typeof e === "string").sort();
      if (name === "default") {
        defaultFeatures = enables;
      } else if (PROFILE_NAMES.has(name)) {
        profiles[name] = { description: "", enables };
      }
    }
  } else {
    console.error("  ! could not fetch facade Cargo.toml (profiles/default unavailable)");
  }

  const closed = closure(graph);

  // ---- Plugin gates ------------------------------------------------------
  console.log("Fetching default plugin gates…");
  const pluginsSrc = await fetchText(`${RAW}/${tag}/crates/bevy_internal/src/default_plugins.rs`);
  const gates = pluginsSrc ? pluginGates(pluginsSrc) : [];
  console.log(`  plugin gates: ${gates.length}`);

  // ---- Panic-site formats ------------------------------------------------
  console.log("Scanning panic sites…");
  const panicSites: Record<string, Array<{ file: string; line: number }>> = {};
  const ecsSrc = await fetchText(`${RAW}/${tag}/crates/bevy_ecs/src/system/system_param.rs`);
  if (ecsSrc) {
    const re = /(error|warning)\[(B\d{4})\]/g;
    let m: RegExpExecArray | null;
    let line = 1;
    let lastIdx = 0;
    const lines = ecsSrc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/(error|warning)\[(B\d{4})\]/.test(lines[i]!)) {
        const codeMatch = lines[i]!.match(/(B\d{4})/);
        if (codeMatch) {
          const code = codeMatch[1]!;
          if (!panicSites[code]) panicSites[code] = [];
          panicSites[code]!.push({ file: "crates/bevy_ecs/src/system/system_param.rs", line: i + 1 });
        }
      }
    }
  }
  console.log(`  panic-site codes found: ${Object.keys(panicSites).join(", ") || "(none)"}`);

  // ---- Write -------------------------------------------------------------
  const commitJson = await fetchText(`${API}/commits/${tag}`);
  let sourceCommit: string | null = null;
  if (commitJson) {
    try {
      sourceCommit = (JSON.parse(commitJson) as { sha?: string }).sha ?? null;
    } catch { /* optional provenance */ }
  }

  fs.writeFileSync(dest("meta.json"), JSON.stringify({
    bevy_version: version,
    tag,
    source_commit: sourceCommit,
    harvested_at: new Date().toISOString(),
    error_codes: codeFiles.map((e) => e.name.replace(/\.md$/, "")).sort(),
    panic_site_codes: Object.keys(panicSites).sort(),
  }, null, 2) + "\n");

  fs.writeFileSync(dest("features.json"), JSON.stringify({
    bevy_version: version,
    features: graph,
    closure: closed,
    profiles,
    default_features: defaultFeatures,
    plugin_gates: gates,
    panic_sites: panicSites,
  }, null, 2) + "\n");

  console.log(`\nDone. ${Object.keys(graph).length} features, ${codesWritten} error codes, ${gates.length} plugin gates.`);
  console.log(`Output: ${outRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
