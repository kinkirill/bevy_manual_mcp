#!/usr/bin/env node
/**
 * Build (or rebuild) the persisted search index for one version and exit.
 *
 * The MCP server normally builds the index lazily on first start, then blocks
 * on stdio. That is fine interactively but useless in CI, where we need a
 * command that builds and returns. This is that command.
 *
 * Usage:
 *   node scripts/build-index.mjs              # version from config/Cargo.lock
 *   node scripts/build-index.mjs 0.20.0
 *   node scripts/build-index.mjs 0.20.0 --force
 *
 * Requires a rustdoc source: either BEVY_DOC_DIR, or target/doc under the
 * project root (see scripts/fetch-docs.mjs to mirror from docs.rs).
 */

import { resolveConfig, log } from "../src/config.js";
import { VersionRegistry } from "../src/registry.js";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--")) || null;
const force = args.includes("--force");

const config = resolveConfig();
const target = version || config.bevyVersion;

if (!target) {
  console.error(
    "No Bevy version to build. Pass one (node scripts/build-index.mjs 0.20.0) " +
      "or point BEVY_PROJECT_ROOT at a Cargo project.",
  );
  process.exit(1);
}

if (!config.docDir && !version) {
  log("warning: no rustdoc directory found; the API half of the index will be empty.");
}

const started = Date.now();
const registry = new VersionRegistry(config);
await registry.get(target, { force });
log(`build complete for ${target} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(0);
