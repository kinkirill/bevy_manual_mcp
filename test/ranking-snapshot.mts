#!/usr/bin/env node
/**
 * Capture a ranking snapshot of the real Bevy index.
 *
 * Purpose: prove that an ingest-side change (adding struct fields) did not
 * perturb search results. Fields are ~10-15k new records; if they leak into the
 * text index at full weight they would flood results, which is exactly the
 * regression this script is built to catch.
 *
 * Usage:
 *   node test/ranking-snapshot.mjs capture  # writes test/fixtures/ranking-snapshot.json
 *   node test/ranking-snapshot.mjs verify  # exits 1 on any difference
 *
 * Not part of `npm test`: it needs the full rustdoc-derived index in data/,
 * which CI does not have. The durable CI-level guard for fields is the
 * synthetic-fixture test in run-tests.mjs; this is the full-corpus check.
 */

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./helpers.mjs";
import { parseJson } from "../src/types.js";

import { resolveConfig } from "../src/config.js";
import { VersionRegistry } from "../src/registry.js";
import { hybridSearch } from "../src/store.js";

const SNAPSHOT_PATH = path.join(REPO_ROOT, "test", "fixtures", "ranking-snapshot.json");
interface Snapshot { bevy_version: string; generated_for: string; queries: Record<string, string[]> }

// A fixed query set spanning the ranking paths that matter: exact-symbol hits,
// intent-verb + subject noun, prose-only, filters, and field-name lookups.
const QUERIES = [
  { q: "spawn camera" },
  { q: "system ordering" },
  { q: "Query::iter" },
  { q: "add_systems" },
  { q: "transform" },
  { q: "App" },
  { q: "render world" },
  { q: "keyboard input", limit: 10 },
  { q: "commands spawn", limit: 10 },
  { q: "Camera", kind: "struct" },
  { q: "sphere", kind: "struct,enum" },
  { q: "translation", limit: 15 },
  { q: "scale", limit: 15 },
];

async function capture(version: string | null): Promise<Snapshot> {
  const config = resolveConfig();
  const target = version || config.bevyVersion;
  if (!target) {
    console.error("No Bevy version resolved. Set BEVY_VERSION or BEVY_PROJECT_ROOT.");
    process.exit(2);
  }
  const registry = new VersionRegistry(config);
  const index = await registry.get(target);

  const out: Snapshot = { bevy_version: target, generated_for: "ranking-stability", queries: {} };
  for (const { q, limit, kind } of QUERIES) {
    const res = hybridSearch(index, q, { limit: limit ?? 8, filters: kind ? { kind } : {} });
    out.queries[q + (kind ? ` [${kind}]` : "")] = res.map((r) => r.record.full_path);
  }
  return out;
}

function compare(expected: Snapshot, actual: Snapshot): string[] {
  const diffs = [];
  const keys = new Set([...Object.keys(expected.queries), ...Object.keys(actual.queries)]);
  for (const k of keys) {
    const a = expected.queries[k];
    const b = actual.queries[k];
    if (!a || !b) {
      diffs.push(`${k}: ${a ? "missing from actual" : "missing from snapshot"}`);
      continue;
    }
    if (a.length !== b.length) {
      diffs.push(`${k}: length ${a.length} -> ${b.length}`);
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        diffs.push(`${k}: [${i}] ${a[i]} -> ${b[i]}`);
        break;
      }
    }
  }
  return diffs;
}

function readSnapshot(text: string): Snapshot {
  const value = parseJson(text);
  if (typeof value !== "object" || value === null || !("bevy_version" in value) || typeof value.bevy_version !== "string" || !("queries" in value) || typeof value.queries !== "object" || value.queries === null) {
    throw new Error("Invalid ranking snapshot");
  }
  const queries: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(value.queries)) {
    if (!Array.isArray(items) || !items.every((item: unknown) => typeof item === "string")) throw new Error("Invalid ranking snapshot query");
    queries[key] = items as string[];
  }
  return { bevy_version: value.bevy_version, generated_for: "ranking-stability", queries };
}

const mode = process.argv[2] || "capture";
const version = process.argv[3] || process.env.BEVY_VERSION || null;

if (mode === "capture") {
  const snap = await capture(version);
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + "\n");
  console.error(`wrote ${SNAPSHOT_PATH} (bevy ${snap.bevy_version})`);
} else if (mode === "verify") {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`No snapshot at ${SNAPSHOT_PATH}. Capture one first.`);
    process.exit(2);
  }
  const expected = readSnapshot(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  const actual = await capture(version);
  if (expected.bevy_version !== actual.bevy_version) {
    console.error(
      `Snapshot is for bevy ${expected.bevy_version} but index resolved to ` +
        `${actual.bevy_version}. Re-capture for this version.`,
    );
    process.exit(2);
  }
  const diffs = compare(expected, actual);
  if (diffs.length) {
    console.error(`RANKING CHANGED (${diffs.length} query/queries differ):`);
    for (const d of diffs) console.error(`  ${d}`);
    process.exit(1);
  }
  console.error(
    `ranking unchanged across ${Object.keys(actual.queries).length} queries ` +
      `(bevy ${actual.bevy_version})`,
  );
} else {
  console.error("Usage: node test/ranking-snapshot.mjs [capture|verify] [version]");
  process.exit(2);
}
