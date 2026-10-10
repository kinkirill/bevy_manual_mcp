#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_ROOT, resolveConfig } from "../src/config.js";
import { errorMessage, validateOutputTarget } from "./cli-utils.mjs";

const UPSTREAM = process.env.BEVY_WEBSITE_REPO || "https://github.com/bevyengine/bevy-website.git";

const SPARSE_PATTERNS = [
  "/content/**/*.md",
  "/release-content/**/*.md",
  "/release-content/**/*.rs",
  "/learning-code-examples/**/*.rs",
  "/LICENSE",
];

function git(args: string[], cwd?: string): void {
  const r = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`[bevy-mcp] git not available: ${r.error.message}`);
    throw r.error;
  }
  if (r.status !== 0) throw new Error(`git failed with exit code ${r.status ?? 1}`);
}

function copyProse(from: string, to: string) {
  let count = 0;
  let bytes = 0;

  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const src = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(src);
        continue;
      }
      if (!/\.(md|rs)$/.test(e.name) && e.name !== "LICENSE") continue;
      const rel = path.relative(from, src);
      const dest = path.join(to, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      count++;
      bytes += fs.statSync(dest).size;
    }
  };

  walk(from);
  return { count, bytes };
}

function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, ref: { type: "string", default: "main" } } });
  const config = resolveConfig();
  const outDir = validateOutputTarget(values.out || path.join(PACKAGE_ROOT, "vendor", "bevy-website"), [PACKAGE_ROOT, config.projectRoot, process.cwd()]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-website-"));

  console.log(`Fetching bevy-website (${values.ref}) - prose only, no media`);
  try {
    git(
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        values.ref,
        UPSTREAM,
        tmp,
      ],
      undefined,
    );
    // Non-cone patterns select source files without downloading adjacent media.
    git(["sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS], tmp);

    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(outDir), ".bevy-website-stage-"));
    const backup = `${staging}-previous`;
    let result;
    try {
      result = copyProse(tmp, staging);
      if (!result.count) throw new Error("No prose files found; existing website was preserved.");
      if (fs.existsSync(outDir)) fs.renameSync(outDir, backup);
      try {
        fs.renameSync(staging, outDir);
      } catch (error) {
        if (fs.existsSync(backup)) fs.renameSync(backup, outDir);
        throw error;
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const { count, bytes } = result;
    console.log(
      `\nWrote ${count} files (${(bytes / 1048576).toFixed(2)} MB) to ${outDir}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[bevy-mcp] ${errorMessage(error)}`);
  process.exitCode = 1;
}
