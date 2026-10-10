#!/usr/bin/env node
/** Rebuild existing rustdoc mirrors sequentially, without downloading sources. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detectDocVersion, PACKAGE_ROOT, resolveConfig } from "../src/config.js";
import { errorMessage, stableVersion } from "./cli-utils.mjs";
import { readRegistry } from "./index-artifacts.mjs";

const DEFAULT_VERSIONS = ["0.15.3", "0.16.1", "0.17.3", "0.18.1", "0.19.1", "0.20.0"];
const buildScript = fileURLToPath(new URL("./build-index.mjs", import.meta.url));

function directoryExists(directory: string): boolean {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function htmlPages(directory: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += htmlPages(path.join(directory, entry.name));
    else if (entry.isFile() && entry.name.endsWith(".html")) count++;
  }
  return count;
}

function build(version: string, docDir: string, dataDir: string, projectRoot: string): Promise<number> {
  const options = process.env.NODE_OPTIONS ?? "";
  const nodeOptions = /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(options)
    ? options : `${options} --max-old-space-size=6144`.trim();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [buildScript, version, "--force"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, BEVY_PROJECT_ROOT: projectRoot, BEVY_VERSION: version,
        BEVY_DOC_DIR: docDir, BEVY_MCP_DATA_DIR: dataDir, BEVY_MCP_OFFLINE: "1", NODE_OPTIONS: nodeOptions },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) console.error(`!! ${version}: rebuild interrupted by ${signal}`);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { data: { type: "string" }, "mirror-root": { type: "string" }, help: { type: "boolean" } } });
  if (args.values.help) {
    console.log("Usage: node scripts/rebuild-all-indexes.mjs [version ...] [--data directory] [--mirror-root directory]\n" +
      "Rebuilds existing mirrors offline, sequentially and with --force. Missing mirrors are skipped; failed builds exit nonzero.\n" +
      `Defaults: ${DEFAULT_VERSIONS.join(" ")}`);
    return;
  }
  const versions = [...new Set((args.positionals.length ? args.positionals : DEFAULT_VERSIONS).map(stableVersion))];
  const baseline = resolveConfig();
  const configurations = versions.map((version) => ({ version, config: resolveConfig({ bevyVersion: version }) }));
  const versionSpecificMirrors = new Set(configurations.map(({ config }) => path.resolve(config.mirrorDir))).size === versions.length;
  const mirrorRoot = args.values["mirror-root"] ? path.resolve(args.values["mirror-root"]) : null;
  let rebuilt = 0;
  let skipped = 0;
  let failed = 0;
  let dataDir: string | undefined;
  for (const { version, config } of configurations) {
    dataDir = path.resolve(args.values.data ?? config.dataDir);
    const sharedSource = (directory: string | null): string | null => directory &&
      (versions.length === 1 || detectDocVersion(directory)?.version === version || baseline.bevyVersion === version)
      ? directory : null;
    const candidates = mirrorRoot
      ? [path.join(mirrorRoot, version), path.join(mirrorRoot, `bevy-${version}`), path.join(mirrorRoot, `bevy-docs-${version}`)]
      : [sharedSource(config.docDir), versionSpecificMirrors ? config.mirrorDir : sharedSource(config.mirrorDir),
        path.join(PACKAGE_ROOT, `bevy-docs-${version}`),
        path.join(os.homedir(), ".cache", "bevy-mcp", `bevy-${version}`)];
    const docDir = candidates.find((candidate): candidate is string => candidate !== null && directoryExists(candidate));
    if (!docDir) {
      console.log(`!! ${version}: no rustdoc mirror -- skipping (${candidates.filter(Boolean).join(", ")})`);
      skipped++;
      continue;
    }
    const started = Date.now();
    try {
      const pages = htmlPages(docDir);
      if (pages === 0) throw new Error(`Rustdoc mirror contains no HTML pages: ${docDir}`);
      console.log(`=== ${version} (${pages} pages at ${docDir}) ===`);
      const status = await build(version, path.resolve(docDir), dataDir, config.projectRoot);
      if (status !== 0) throw new Error(`build-index exited ${status}`);
      rebuilt++;
      console.log(`    ${version} rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      failed++;
      console.error(`!! ${version}: rebuild failed: ${errorMessage(error)}`);
    }
  }
  console.log(`\nRebuild summary: ${rebuilt} rebuilt, ${skipped} skipped, ${failed} failed.`);
  if (dataDir && fs.existsSync(path.join(dataDir, "registry.json"))) {
    console.log(`=== registry summary (${dataDir}) ===`);
    for (const entry of Object.values(readRegistry(dataDir).versions)) {
      console.log(`  ${entry.version.padEnd(8)} cache_version=${entry.cache_version ?? "MISSING"} ` +
        `records=${String(entry.records ?? 0).padStart(7)} fields=${String(entry.by_kind?.field ?? 0).padStart(5)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

try { await main(); }
catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
