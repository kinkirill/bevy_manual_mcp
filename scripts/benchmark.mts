#!/usr/bin/env node
/**
 * Informational performance baseline (Phase 0).
 *
 * Measures the four quantities the enhancement plan asks to track:
 *   - cold startup  — first load of an index in a fresh process
 *   - warm startup  — the same load served from the in-process cache
 *   - exact symbol lookup
 *   - representative concept searches
 *
 * It prefers an already-installed index (never triggering a rebuild) and falls
 * back to a deterministic synthetic corpus so it is reproducible without a
 * multi-gigabyte download. Timings are informational; this script never exits
 * non-zero on a slow result.
 *
 * Usage:
 *   npm run bench                 # real index if installed, else synthetic
 *   npm run bench -- --synthetic  # force the synthetic corpus
 *   npm run bench -- --version 0.20.0
 */
import { parseArgs } from "node:util";
import { resolveConfig } from "../src/config.js";
import { VersionRegistry } from "../src/registry.js";
import { BevyIndex, hybridSearch } from "../src/store.js";
import type { BevyRecord } from "../src/types.js";

const EXACT_SYMBOLS = ["App::add_systems", "Query", "Camera2d", "Transform", "World"];
const CONCEPT_QUERIES = [
  "system ordering",
  "2d camera",
  "spawn ui text",
  "change detection",
  "play sound",
];

interface Timing {
  label: string;
  ms: number;
  detail: string;
}

interface BenchmarkIndex {
  index: BevyIndex;
  source: "installed" | "synthetic";
  version: string | null;
  loadTimings: Timing[];
}

function elapsedMs(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
}

function mean(values: number[]): number {
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

async function buildSynthetic(count: number): Promise<BevyIndex> {
  const owners = ["Transform", "Velocity", "Query", "App", "World", "Entity", "Commands", "Res", "Camera2d", "Node"];
  const records: BevyRecord[] = [];
  for (let i = 0; i < count; i++) {
    const owner = owners[i % owners.length]!;
    records.push({
      source: "rustdoc", kind: "method", name: `method_${i}`, owner,
      full_path: `bevy::fixture::${owner}::method_${i}`,
      docs: `Fixture method ${i} operating on ${owner}.`,
      signature: `pub fn method_${i}(&self) -> ${owner}`,
      module: "bevy::fixture", file: "fixture.html", bevy_version: "synthetic",
    });
  }
  for (const name of owners) {
    records.push({
      source: "rustdoc", kind: "struct", name, full_path: `bevy::fixture::${name}`,
      docs: `Fixture type ${name}.`, signature: `pub struct ${name}`,
      module: "bevy::fixture", file: "fixture.html", bevy_version: "synthetic",
    });
  }
  const index = new BevyIndex();
  index.addRecords(records);
  index.buildSymbolTable();
  await index.buildTextIndex();
  index.meta = { bevy_version: "synthetic", symbols: index.symbols.size, built_at: new Date().toISOString() };
  index.stats = index.stats_();
  return index;
}

async function pickBenchmarkIndex(forceSynthetic: boolean, explicitVersion?: string): Promise<BenchmarkIndex> {
  const config = resolveConfig();
  if (!forceSynthetic) {
    const registry = new VersionRegistry(config);
    const candidates = explicitVersion
      ? [explicitVersion]
      : config.bevyVersion ? [config.bevyVersion] : registry.versions();
    const version = candidates.find((v) => registry.has(v) && registry.readPersistedCacheVersion(v) !== null);
    if (version) {
      // A fresh registry makes the first `get` a genuine cold load.
      const fresh = new VersionRegistry(config);
      const coldStart = process.hrtime.bigint();
      const index = await fresh.get(version);
      const cold = elapsedMs(coldStart);
      const warmStart = process.hrtime.bigint();
      await fresh.get(version);
      const warm = elapsedMs(warmStart);
      return {
        index, source: "installed", version,
        loadTimings: [
          { label: "startup:cold", ms: cold, detail: `${index.records.length} records` },
          { label: "startup:warm", ms: warm, detail: "in-process cache" },
        ],
      };
    }
  }
  const buildStart = process.hrtime.bigint();
  const index = await buildSynthetic(15_000);
  return {
    index, source: "synthetic", version: explicitVersion ?? null,
    loadTimings: [{ label: "startup:build", ms: elapsedMs(buildStart), detail: `${index.records.length} records` }],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { synthetic: { type: "boolean" }, version: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  const { index, source, version, loadTimings } = await pickBenchmarkIndex(
    values.synthetic === true,
    typeof values.version === "string" ? values.version : undefined,
  );

  const timings: Timing[] = [...loadTimings];
  for (const symbol of EXACT_SYMBOLS) {
    const start = process.hrtime.bigint();
    const hits = index.lookupSymbol(symbol);
    timings.push({ label: `lookup:${symbol}`, ms: elapsedMs(start), detail: `${hits.length} hit(s)` });
  }
  for (const query of CONCEPT_QUERIES) {
    const runs: number[] = [];
    let top = "(none)";
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      const hits = hybridSearch(index, query, { limit: 5 });
      runs.push(elapsedMs(start));
      top = hits[0]?.record.full_path ?? top;
    }
    timings.push({ label: `search:${query}`, ms: mean(runs), detail: top });
  }

  const records = index.records.length;
  process.stdout.write(`\n# Performance baseline (${source}, Bevy ${version ?? "n/a"})\n\n`);
  process.stdout.write(`Index: ${records.toLocaleString()} records, ${index.symbols.size.toLocaleString()} symbols\n\n`);
  process.stdout.write("| measurement | ms | detail |\n|---|---:|---|\n");
  for (const timing of timings) {
    process.stdout.write(`| ${timing.label} | ${timing.ms} | ${timing.detail} |\n`);
  }
  process.stdout.write(
    "\n```json\n" +
      JSON.stringify({
        source, version, records, symbols: index.symbols.size,
        measured_at: new Date().toISOString(), node: process.version,
        platform: `${process.platform}/${process.arch}`, timings,
      }, null, 2) +
      "\n```\n",
  );
}

main().catch((error) => {
  process.stderr.write(`benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
