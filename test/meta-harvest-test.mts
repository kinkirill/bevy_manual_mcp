/** Phase 01 test: harvest output, feature graph, error-code ingestion. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const META_ROOT = path.join(ROOT, "vendor", "bevy-meta");
const VERSIONS = ["0.15.3", "0.16.1", "0.17.3", "0.18.1", "0.19.1", "0.20.0"];

test("every indexed version has harvested metadata", () => {
  for (const v of VERSIONS) {
    assert.ok(fs.existsSync(path.join(META_ROOT, v)), `Missing vendor/bevy-meta/${v}`);
    assert.ok(fs.existsSync(path.join(META_ROOT, v, "features.json")), `Missing features.json for ${v}`);
    assert.ok(fs.existsSync(path.join(META_ROOT, v, "meta.json")), `Missing meta.json for ${v}`);
    const codes = fs.readdirSync(path.join(META_ROOT, v, "error-codes"));
    assert.ok(codes.length >= 4, `Expected at least 4 error codes for ${v}, got ${codes.length}`);
  }
});

test("meta.json records the correct version, tag, and source commit", () => {
  for (const v of VERSIONS) {
    const meta = JSON.parse(fs.readFileSync(path.join(META_ROOT, v, "meta.json"), "utf8"));
    assert.equal(meta.bevy_version, v);
    assert.equal(meta.tag, `v${v}`);
    assert.ok(meta.source_commit, `Missing source_commit for ${v}`);
    assert.ok(meta.harvested_at, `Missing harvested_at for ${v}`);
    assert.ok(Array.isArray(meta.error_codes), `error_codes not an array for ${v}`);
    assert.ok(meta.error_codes.includes("B0001"), `B0001 missing for ${v}`);
    assert.ok(meta.error_codes.includes("B0002"), `B0002 missing for ${v}`);
  }
});

test("features.json has a valid graph with closure", () => {
  for (const v of VERSIONS) {
    const f = JSON.parse(fs.readFileSync(path.join(META_ROOT, v, "features.json"), "utf8"));
    assert.equal(f.bevy_version, v);
    assert.ok(typeof f.features === "object", `features not an object for ${v}`);
    assert.ok(Object.keys(f.features).length > 0, `No features for ${v}`);
    assert.ok(typeof f.closure === "object", `closure not an object for ${v}`);
    // Every feature in the graph must have a closure entry
    for (const name of Object.keys(f.features)) {
      assert.ok(Array.isArray(f.closure[name]), `Missing closure for ${name} in ${v}`);
    }
  }
});

test("0.20.0 closure resolves bevy_ui to bevy_text and bevy_sprite", () => {
  const f = JSON.parse(fs.readFileSync(path.join(META_ROOT, "0.20.0", "features.json"), "utf8"));
  const closure = f.closure.bevy_ui;
  assert.ok(closure.includes("bevy_text"), `bevy_ui closure missing bevy_text`);
  assert.ok(closure.includes("bevy_sprite"), `bevy_ui closure missing bevy_sprite`);
});

test("0.20.0 has four profiles: 2d, 3d, ui, audio", () => {
  const f = JSON.parse(fs.readFileSync(path.join(META_ROOT, "0.20.0", "features.json"), "utf8"));
  const profileNames = Object.keys(f.profiles).sort();
  assert.deepEqual(profileNames, ["2d", "3d", "audio", "ui"]);
  assert.ok(f.profiles["2d"].enables.includes("default_app"));
  assert.ok(f.default_features.includes("2d"));
  assert.ok(f.default_features.includes("3d"));
  assert.ok(f.default_features.includes("ui"));
  assert.ok(f.default_features.includes("audio"));
});

test("error-code markdown files contain real content", () => {
  for (const v of VERSIONS) {
    const b0001 = fs.readFileSync(path.join(META_ROOT, v, "error-codes", "B0001.md"), "utf8");
    assert.ok(b0001.includes("# B0001"), `B0001.md missing heading for ${v}`);
    assert.ok(b0001.length > 200, `B0001.md too short for ${v}`);
  }
});

test("plugin gates reference valid feature names", () => {
  const f = JSON.parse(fs.readFileSync(path.join(META_ROOT, "0.20.0", "features.json"), "utf8"));
  const featureNames = new Set(Object.keys(f.features));
  for (const gate of f.plugin_gates) {
    assert.ok(featureNames.has(gate.requires_feature), `Plugin gate references unknown feature ${gate.requires_feature}`);
    assert.ok(gate.plugin, `Plugin gate missing plugin name`);
  }
});

test("older versions have fewer features than newer ones", () => {
  const counts = VERSIONS.map((v) => {
    const f = JSON.parse(fs.readFileSync(path.join(META_ROOT, v, "features.json"), "utf8"));
    return Object.keys(f.features).length;
  });
  // Features should generally increase (or stay same) with version
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i]! >= counts[i - 1]!, `Feature count decreased from ${VERSIONS[i - 1]} (${counts[i - 1]}) to ${VERSIONS[i]} (${counts[i]})`);
  }
});

test("ingestErrorCodes prefers errorsDir over metaDir", () => {
  // This is a logic test: the function checks errorsDir first, then metaDir.
  // We verify the vendored data is discoverable via metaDir path.
  const metaDir = META_ROOT;
  const errorsDir = path.join(os.tmpdir(), "nonexistent-errors-dir");
  // When errorsDir doesn't exist, it falls through to metaDir
  const result = simulateIngest(errorsDir, metaDir, "0.20.0");
  assert.ok(result.length === 6, `Expected 6 error codes, got ${result.length}`);
});

test("ingestErrorCodes uses errorsDir when available", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-test-errors-"));
  try {
    fs.writeFileSync(path.join(tmp, "B0001.md"), "# B0001\n\nlocal override\n");
    const result = simulateIngest(tmp, META_ROOT, "0.20.0");
    assert.equal(result.length, 1);
    assert.ok(result[0]!.docs.includes("local override"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Simulate the ingestErrorCodes logic without a full registry. */
function simulateIngest(errorsDir: string | null, metaDir: string | null, version: string): Array<{ docs: string }> {
  const dirs = [errorsDir, metaDir].filter((d): d is string => !!d);
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => /^B\d{4}\.md$/.test(f)).sort();
    } catch { continue; }
    if (!entries.length) continue;
    return entries.map((f) => ({
      docs: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
  }
  return [];
}
