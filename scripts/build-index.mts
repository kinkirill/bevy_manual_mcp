#!/usr/bin/env node
// Exits after persisting the index; a matching Rustdoc source supplies its API records.

import { resolveConfig, log } from "../src/config.js";
import { VersionRegistry } from "../src/registry.js";
import { versionArgs } from "./cli-utils.mjs";

const args = versionArgs(process.argv.slice(2), { force: { type: "boolean" } });
const version = args.version;
const force = args.values.force === true;

const config = resolveConfig({ bevyVersion: version });
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
