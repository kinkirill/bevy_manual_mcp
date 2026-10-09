#!/usr/bin/env node
/**
 * Refresh the vendored bevy-website prose.
 *
 * The repository ships a trimmed copy of bevy-website (Markdown and Rust source
 * only — no media) so that the Book, migration guides, release notes and
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
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = process.env.BEVY_WEBSITE_REPO || "https://github.com/bevyengine/bevy-website.git";

const SPARSE_PATTERNS = [
  "/content/**/*.md",
  "/release-content/**/*.md",
  "/release-content/**/*.rs",
  "/learning-code-examples/**/*.rs",
  "/LICENSE",
];

function parseArgs(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  return { out: opt("--out"), ref: opt("--ref") || "main" };
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`[bevy-mcp] git not available: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Copy only the prose sources upstream, preserving directory structure. */
function copyProse(from, to) {
  let count = 0;
  let bytes = 0;

  const walk = (dir) => {
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
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || path.join(ROOT, "vendor", "bevy-website"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-website-"));

  console.log(`Fetching bevy-website (${args.ref}) — prose only, no media`);
  try {
    git(
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        args.ref,
        UPSTREAM,
        tmp,
      ],
      undefined,
    );
    // Non-cone patterns let us pull just .md/.rs, so news .mp4/.png blobs are
    // never fetched despite living in the same directories.
    git(["sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS], tmp);

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const { count, bytes } = copyProse(tmp, outDir);
    console.log(
      `\nWrote ${count} files (${(bytes / 1048576).toFixed(2)} MB) to ${outDir}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
