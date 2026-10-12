#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../src/config.js";
import { versionArgs, stringOption, stableVersion, errorMessage } from "./cli-utils.mjs";
import { INDEX_FILES, readRegistry, validateIndex } from "./index-artifacts.mjs";
import { INDEX_MANIFEST_ASSET, type IndexManifest } from "./index-release.mjs";
import { CACHE_VERSION } from "../src/store.js";

async function main(): Promise<void> {
  const args = versionArgs(process.argv.slice(2), { data: { type: "string" }, out: { type: "string" }, revision: { type: "string" } });
  const config = resolveConfig({ bevyVersion: args.version });
  const version = args.version || config.bevyVersion;
  if (!version) {
    console.error("Usage: node scripts/publish-index.mjs <version>");
    process.exit(1);
  }

  stableVersion(version);
  const revision = stringOption(args.values.revision);
  if (revision !== undefined && !/^(?:0|[1-9]\d*)$/.test(revision)) throw new Error("Index revision must be a nonnegative integer.");
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

  // Stage only index files so unrelated data cannot enter the release archive.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-index-bundle-"));
  try {
    fs.mkdirSync(path.join(staging, "versions", sanitized), { recursive: true });
    for (const f of INDEX_FILES) {
      fs.copyFileSync(
        path.join(versionDir, f),
        path.join(staging, "versions", sanitized, f),
      );
    }
    // Install provenance (which asset a user downloaded) must never be baked
    // into a bundle: it describes the consumer's install, not this build.
    const { asset: _installedAsset, revision: _installedRevision, sha256: _installedSha256, ...entryForBundle } = entry;
    fs.writeFileSync(
      path.join(staging, "registry-entry.json"),
      JSON.stringify(entryForBundle, null, 2) + "\n",
    );

    fs.mkdirSync(outDir, { recursive: true });
    const bundle = path.join(outDir, `bevy-index-${version}${revision !== undefined ? `+${revision}` : ""}.tar.gz`);
    const r = spawnSync(
      "tar",
      ["-czf", bundle, "-C", staging, "versions", "registry-entry.json"],
      { stdio: "inherit" },
    );
    if (r.error || r.status !== 0) throw new Error(`tar failed: ${r.error?.message ?? r.status}`);

    const size = fs.statSync(bundle).size;
    const sha256 = createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
    const meta: unknown = JSON.parse(fs.readFileSync(path.join(versionDir, "meta.json"), "utf8"));
    const metaObject = typeof meta === "object" && meta !== null ? meta as Record<string, unknown> : {};
    const manifest: IndexManifest = {
      manifest_version: 1,
      bevy_version: version,
      asset: path.basename(bundle),
      revision: revision !== undefined ? Number(revision) : 0,
      sha256,
      cache_version: CACHE_VERSION,
      size,
      ...(typeof metaObject.api_records === "number" ? { api_records: metaObject.api_records } : {}),
      ...(typeof metaObject.text_indexed === "number" ? { text_indexed: metaObject.text_indexed } : {}),
      ...(typeof metaObject.built_at === "string" ? { built_at: metaObject.built_at } : {}),
      generated_at: new Date().toISOString(),
    };
    const manifestPath = path.join(outDir, INDEX_MANIFEST_ASSET);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log(`\nWrote ${bundle} (${(size / 1048576).toFixed(1)} MB)`);
    console.log(`Wrote ${manifestPath} (revision ${manifest.revision}, sha256 ${sha256.slice(0, 12)}…)`);
    console.log(
      `\nAttach them to the v${version} GitHub Release:\n` +
        `  gh release upload v${version} ${bundle} ${manifestPath} --clobber\n` +
        `or create the release:\n` +
        `  gh release create v${version} ${bundle} ${manifestPath} --title "Bevy ${version} index" \\\n` +
        `    --notes "Prebuilt Bevy ${version} index for bevy-mcp."`,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(`[bevy-mcp] ${errorMessage(error)}`); process.exitCode = 1; });
