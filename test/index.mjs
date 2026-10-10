#!/usr/bin/env node
/**
 * `npm test` entry point.
 *
 * Two stages, because they need different environments:
 *
 *   1. run-tests.mjs   unit + ingest + search tests, in-process.
 *   2. resources-test.mjs  MCP spec conformance over a real client, which
 *      spawns index.js as a child process and therefore needs a persisted index
 *      to load. Stage 1 builds one from its synthetic cargo-doc fixture and
 *      leaves it on disk; this script passes its location through.
 *
 * Why this exists: resources-test.mjs was the only check on the resource layer
 * (cursors, completion, error codes, templates) and nothing ran it, so a spec
 * regression would only surface for a user. It could not simply be added to
 * `npm test` on its own -- with no index present the spawned server starts empty
 * and the assertions pass vacuously -- hence the explicit fixture and the
 * non-empty check in stage 1.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function run(label, args, env = {}) {
  process.stderr.write(`\n=== ${label} ===\n`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return r.status ?? 1;
}

// Cleanup must not rely on `finally`: process.exit() skips it, and every exit
// path here needs the temp fixture removed or /tmp accumulates a full index per
// test run. The status is computed first and the process exits once at the end.
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
    const { dataDir, version } = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const resourceStatus = run("resource-layer conformance", [path.join(HERE, "resources-test.mjs")], {
      BEVY_MCP_DATA_DIR: dataDir,
      BEVY_VERSION: version,
      BEVY_MCP_OFFLINE: "1",
    });
    exitCode = unitStatus || resourceStatus;
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

process.exit(exitCode);
