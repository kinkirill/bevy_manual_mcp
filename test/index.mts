#!/usr/bin/env node
/**
 * `npm test` entry point.
 *
 * Build one real Cargo rustdoc fixture, then run ingestion, persistence,
 * configuration and offline MCP protocol tests against that shared fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { REPO_ROOT, fixtureEnv, parseObject } from "./helpers.mjs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = REPO_ROOT;

function run(label: string, args: string[], env: Record<string, string> = {}) {
  process.stderr.write(`\n=== ${label} ===\n`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return r.status ?? 1;
}

// Cleanup must not rely on `finally`: process.exit() skips it, and every exit
// path needs the temporary fixture removed. Compute the status first and exit
// once after cleanup.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-res-"));
let exitCode = 1;
try {
  const unitStatus = run("unit, ingest and search tests", [path.join(HERE, "run-tests.mjs")], {
    RESOURCE_FIXTURE_OUT: fixtureDir,
  });

  const descriptor = path.join(fixtureDir, "resource-fixture.json");
  if (!fs.existsSync(descriptor)) {
    process.stderr.write(
      `\nCould not build the resource fixture, so the resource-layer tests were ` +
        `skipped. Run "node test/run-tests.mjs" alone to see why.\n`,
    );
    exitCode = unitStatus || 1;
  } else {
    const { dataDir, version } = parseObject(fs.readFileSync(descriptor, "utf8"));
    assert.equal(typeof dataDir, "string");
    assert.equal(typeof version, "string");
    assert.ok(typeof dataDir === "string" && typeof version === "string");
    const env = { ...fixtureEnv(fixtureDir, dataDir, version), RESOURCE_FIXTURE_DIR: fixtureDir };
    const regressionStatus = run("configuration, persistence and version regressions", [path.join(HERE, "regressions.mjs")], env);
    const resourceStatus = run("resource-layer conformance", [path.join(HERE, "resources-test.mjs")], env);
    const toolStatus = run("MCP tools and compatibility entrypoints", [path.join(HERE, "mcp-e2e.mjs")], env);
    exitCode = unitStatus || regressionStatus || resourceStatus || toolStatus;
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

process.exit(exitCode);
