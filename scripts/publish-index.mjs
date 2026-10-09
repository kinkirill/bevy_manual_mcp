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

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  return { version: positional[0] || null, data: opt("--data"), out: opt("--out") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();
  const version = args.version || config.bevyVersion;
  if (!version) {
    console.error("Usage: node scripts/publish-index.mjs <version>");
    process.exit(1);
  }

  const dataDir = path.resolve(args.data || config.dataDir);
  const outDir = path.resolve(args.out || path.join(process.cwd(), "dist"));
  const sanitized = String(version).replace(/[^a-zA-Z0-9._+-]/g, "_");
  const versionDir = path.join(dataDir, "versions", sanitized);

  for (const f of ["records.ndjson", "text-index.json", "meta.json"]) {
    const p = path.join(versionDir, f);
    if (!fs.existsSync(p)) {
      console.error(
        `Missing ${p}.\nBuild this version first:  node scripts/build-index.mjs <version> --force`,
      );
      process.exit(1);
    }
  }

  const registry = JSON.parse(
    fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"),
  );
  const entry = registry.versions?.[sanitized];
  if (!entry) {
    console.error(
      `No registry entry for ${version} in ${dataDir}/registry.json - build it first.`,
    );
    process.exit(1);
  }

  // Stage only what belongs in the bundle so the tarball cannot pick up stray
  // files from the data directory.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-index-bundle-"));
  try {
    fs.mkdirSync(path.join(staging, "versions", sanitized), { recursive: true });
    for (const f of ["records.ndjson", "text-index.json", "meta.json"]) {
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
    if (r.status !== 0) process.exit(r.status ?? 1);

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

main();
