#!/usr/bin/env node
/**
 * Refresh the vendored bevy-website prose.
 *
 * The repository ships a trimmed copy of bevy-website (Markdown and Rust source
 * only - no media) so that the Book, migration guides, release notes and
 * learning-code-examples work with no network access. This script re-creates
 * that copy from upstream, for when the guides are updated.
 *
 * It uses a partial, sparse clone so that the ~270 MB of news media is never
 * downloaded: only .md/.rs blobs matching the sparse patterns are fetched.
 *
 * Usage:
 *   node scripts/fetch-website.mjs                 # into ./vendor/bevy-website
 *   node scripts/fetch-website.mjs --out /tmp/www
 *   node scripts/fetch-website.mjs --ref main
 */

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

/** Copy only the prose sources upstream, preserving directory structure. */
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
    // Non-cone patterns let us pull just .md/.rs, so news .mp4/.png blobs are
    // never fetched despite living in the same directories.
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
