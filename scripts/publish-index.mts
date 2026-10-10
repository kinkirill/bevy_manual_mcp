#!/usr/bin/env node
/**
 * Package a built index into a distributable tarball for a GitHub Release.
 *
 * This is the maintainer side of `fetch-index.mjs`. It does not build anything:
 * the version must already be present in the data directory (built with
 * `node index.js` after mirroring docs). It produces:
 *
 *   dist/bevy-index-<version>.tar.gz
 *     ├── versions/<version>/{meta.json,records.ndjson,text-index.json}
 *     └── registry-entry.json
 *
 * Attach that file to the `v<version>` GitHub Release so users can install the
 * index with `bevy-mcp fetch-index`.
 *
 * Usage:
 *   node scripts/publish-index.mjs 0.20.0
 *   node scripts/publish-index.mjs 0.20.0 --data ./data --out ./dist
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../src/config.js";
import { versionArgs, stringOption, stableVersion, errorMessage } from "./cli-utils.mjs";
import { INDEX_FILES, readRegistry, validateIndex } from "./index-artifacts.mjs";
import { CACHE_VERSION } from "../src/store.js";

async function main(): Promise<void> {
  const args = versionArgs(process.argv.slice(2), { data: { type: "string" }, out: { type: "string" } });
  const config = resolveConfig({ bevyVersion: args.version });
  const version = args.version || config.bevyVersion;
  if (!version) {
    console.error("Usage: node scripts/publish-index.mjs <version>");
    process.exit(1);
  }

  stableVersion(version);
  const dataDir = path.resolve(stringOption(args.values.data) || config.dataDir);
  const outDir = path.resolve(stringOption(args.values.out) || path.join(process.cwd(), "dist"));
  const sanitized = String(version).replace(/[^a-zA-Z0-9._+-]/g, "_");
  const versionDir = path.join(dataDir, "versions", sanitized);

  for (const f of INDEX_FILES) {
    const p = path.join(versionDir, f);
    if (!fs.existsSync(p)) {
      console.error(
        `Missing ${p}.\nBuild this version first:  node scripts/build-index.mjs <version> --force`,
      );
      throw new Error(`Missing ${p}; build this version first.`);
    }
  }

  const registry = readRegistry(dataDir);
  const entry = registry.versions?.[sanitized];
  if (!entry) {
    console.error(
      `No registry entry for ${version} in ${dataDir}/registry.json - build it first.`,
    );
    throw new Error(`No registry entry for ${version}; build this version first.`);
  }
  if (entry.cache_version !== CACHE_VERSION) throw new Error("Registry cache format is stale; rebuild this version first.");
  await validateIndex(versionDir, version);

  // Stage only what belongs in the bundle so the tarball cannot pick up stray
  // files from the data directory.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-index-bundle-"));
  try {
    fs.mkdirSync(path.join(staging, "versions", sanitized), { recursive: true });
    for (const f of INDEX_FILES) {
      fs.copyFileSync(
        path.join(versionDir, f),
        path.join(staging, "versions", sanitized, f),
      );
    }
    fs.writeFileSync(
      path.join(staging, "registry-entry.json"),
      JSON.stringify(entry, null, 2) + "\n",
    );

    fs.mkdirSync(outDir, { recursive: true });
    const bundle = path.join(outDir, `bevy-index-${version}.tar.gz`);
    const r = spawnSync(
      "tar",
      ["-czf", bundle, "-C", staging, "versions", "registry-entry.json"],
      { stdio: "inherit" },
    );
    if (r.error || r.status !== 0) throw new Error(`tar failed: ${r.error?.message ?? r.status}`);

    const size = fs.statSync(bundle).size;
    console.log(`\nWrote ${bundle} (${(size / 1048576).toFixed(1)} MB)`);
    console.log(
      `\nAttach it to the v${version} GitHub Release:\n` +
        `  gh release create v${version} ${bundle} --title "Bevy ${version} index" \\\n` +
        `    --notes "Prebuilt Bevy ${version} index for bevy-mcp."\n` +
        `or upload via the GitHub web UI.`,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(`[bevy-mcp] ${errorMessage(error)}`); process.exitCode = 1; });
