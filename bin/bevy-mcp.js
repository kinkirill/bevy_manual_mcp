#!/usr/bin/env node
/**
 * bevy-mcp CLI.
 *
 * With no subcommand this starts the stdio MCP server, exactly like
 * `node index.js`. The subcommands cover one-time setup so that people who
 * install from npm never have to juggle environment variables:
 *
 *   bevy-mcp                 start the MCP server (stdio)
 *   bevy-mcp fetch-index     download the prebuilt index for your Bevy version
 *   bevy-mcp fetch-docs      mirror rustdoc from docs.rs (advanced / new versions)
 *   bevy-mcp fetch-website   refresh the vendored bevy-website prose
 *   bevy-mcp status          show resolved paths and index state
 *   bevy-mcp help            this text
 *
 * Diagnostics always go to stderr: stdout is reserved for the MCP JSON-RPC
 * stream once the server is running.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const [, , cmd, ...rest] = process.argv;

const USAGE = `bevy-mcp - version-accurate Bevy knowledge for AI agents

Usage:
  bevy-mcp                 start the MCP server (stdio)
  bevy-mcp fetch-index     download the prebuilt search index for your Bevy version
  bevy-mcp fetch-docs      mirror rustdoc from docs.rs, then rebuild (advanced)
  bevy-mcp fetch-website   refresh the vendored bevy-website prose
  bevy-mcp status          show resolved paths and index state
  bevy-mcp help            show this help

Run this from (or point BEVY_PROJECT_ROOT at) your Bevy project; the version is
read from Cargo.lock. Set BEVY_VERSION to override.
`;

/** Run one of the setup scripts in a child process, inheriting stdio. */
function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      cwd: ROOT,
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on("error", (err) => {
      console.error(`[bevy-mcp] could not run ${path.basename(script)}: ${err.message}`);
      resolve(1);
    });
  });
}

async function status() {
  const { resolveConfig } = await import(
    pathToFileURL(path.join(ROOT, "src", "config.js")).href
  );
  const config = resolveConfig();
  const indexDir = config.bevyVersion
    ? path.join(config.dataDir, "versions", String(config.bevyVersion).replace(/[^a-zA-Z0-9._+-]/g, "_"))
    : null;
  const built = indexDir ? fs.existsSync(path.join(indexDir, "records.ndjson")) : false;

  console.log(`bevy-mcp status`);
  console.log(`  project root : ${config.projectRoot}`);
  console.log(`  bevy version : ${config.bevyVersion ?? "UNKNOWN"}  (${config.versionSource ?? "not detected"})`);
  console.log(`  docs dir     : ${config.docDir ?? "(none - index can still be used)"}`);
  console.log(`  website dir  : ${config.websiteDir ?? "(none - book/migration prose unavailable)"}`);
  console.log(`  examples dir : ${config.examplesDir ?? "(none)"}`);
  console.log(`  data dir     : ${config.dataDir}`);
  console.log(`  index built  : ${built ? `yes (${indexDir})` : "no - run `bevy-mcp fetch-index`"}`);
  if (config.versionNote) console.log(`  note         : ${config.versionNote}`);
  return built ? 0 : 1;
}

switch (cmd) {
  case undefined:
  case "serve":
  case "start":
  case "mcp":
    await import(pathToFileURL(path.join(ROOT, "index.js")).href);
    break;

  case "fetch-index":
    process.exitCode = await runScript(path.join(ROOT, "scripts", "fetch-index.mjs"), rest);
    break;

  case "fetch-docs":
    process.exitCode = await runScript(path.join(ROOT, "scripts", "fetch-docs.mjs"), rest);
    break;

  case "fetch-website":
    process.exitCode = await runScript(path.join(ROOT, "scripts", "fetch-website.mjs"), rest);
    break;

  case "status":
    process.exitCode = await status();
    break;

  case "help":
  case "-h":
  case "--help":
    console.log(USAGE);
    break;

  default:
    console.error(`[bevy-mcp] unknown command "${cmd}"\n`);
    console.error(USAGE);
    process.exitCode = 1;
}
