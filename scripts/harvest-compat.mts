#!/usr/bin/env node
/**
 * Harvest plugin ↔ Bevy compatibility from crates.io.
 *
 * For every indexed plugin crate this records, per published version, the
 * `bevy` dependency requirement (falling back to a `bevy_*` subcrate). The
 * result is a vendored snapshot so `bevy_ecosystem_compat` works offline and
 * answers reproducibly.
 *
 * Usage: node scripts/harvest-compat.mjs [--out vendor/ecosystem/compat.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, stringOption, versionArgs } from "./cli-utils.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const CRATES = ["bevy_egui", "bevy_rapier3d", "leafwing_input_manager"];
/** How many recent published versions to record per crate. */
const MAX_VERSIONS = 24;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson(url: string, tries = 4): Promise<unknown | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "bevy-mcp/harvest-compat", Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt === tries) return null;
        await sleep(1000 * attempt);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch (err) {
      if (attempt === tries) {
        console.error(`  ! network error ${url}: ${errorMessage(err)}`);
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const { values } = versionArgs(process.argv.slice(2), { out: { type: "string" } });
  const outArg = stringOption(values.out) ?? path.join(ROOT, "vendor", "ecosystem", "compat.json");
  const outPath = path.resolve(outArg);

  const compat: Record<string, Array<{ plugin: string; plugin_version: string; requires_bevy: string }>> = {};

  for (const crate of CRATES) {
    console.log(`Harvesting ${crate}…`);
    const versionsJson = await fetchJson(`https://crates.io/api/v1/crates/${crate}/versions?per_page=100`);
    const versionList = isRecord(versionsJson) && Array.isArray(versionsJson.versions) ? versionsJson.versions : [];
    const stable = versionList
      .filter((v): v is Record<string, unknown> => isRecord(v) && typeof v.num === "string" && v.yanked !== true && !String(v.num).includes("-"))
      .slice(0, MAX_VERSIONS);

    const entries: Array<{ plugin: string; plugin_version: string; requires_bevy: string }> = [];
    for (const version of stable) {
      const num = String(version.num);
      const depsJson = await fetchJson(`https://crates.io/api/v1/crates/${crate}/${num}/dependencies`);
      const deps = isRecord(depsJson) && Array.isArray(depsJson.dependencies) ? depsJson.dependencies : [];
      const bevyDep = deps.find((d): d is Record<string, unknown> =>
        isRecord(d) && d.crate_id === "bevy" && typeof d.req === "string");
      const subDep = bevyDep ?? deps.find((d): d is Record<string, unknown> =>
        isRecord(d) && typeof d.crate_id === "string" && d.crate_id.startsWith("bevy_") && typeof d.req === "string");
      const req = subDep && typeof subDep.req === "string" ? subDep.req : null;
      if (!req) continue;
      entries.push({ plugin: crate, plugin_version: num, requires_bevy: req });
      await sleep(120);
    }
    // Newest first keeps the "what plugin version for my Bevy" answer stable.
    compat[crate] = entries.sort((a, b) => a.plugin_version.localeCompare(b.plugin_version, undefined, { numeric: true })).reverse();
    console.log(`  ${entries.length} versions recorded`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(compat, null, 2) + "\n");
  const total = Object.values(compat).reduce((n, list) => n + list.length, 0);
  console.log(`\nWrote ${total} entries to ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
