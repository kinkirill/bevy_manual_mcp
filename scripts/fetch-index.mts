#!/usr/bin/env node
/** Download and install a versioned index from the project's GitHub Releases. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveConfig } from "../src/config.js";
import { errorMessage, stableVersion, stringOption, versionArgs } from "./cli-utils.mjs";
import { INDEX_FILES, indexPresent, installIndex, readEntry, validateIndex } from "./index-artifacts.mjs";

type DownloadResult = { ok: true; bytes: number } | { ok: false; reason: string };

function mb(bytes: number): string { return `${(bytes / 1048576).toFixed(1)} MB`; }

async function download(url: string, dest: string): Promise<DownloadResult> {
  const res = await fetch(url, { headers: { "User-Agent": "bevy-mcp/fetch-index" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, reason: res.status === 404 ? "not-found" : `HTTP ${res.status}` };
  }
  if (!res.body) return { ok: false, reason: "empty response body" };
  const total = Number(res.headers.get("content-length")) || 0;
  let seen = 0;
  let lastPaint = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        process.stderr.write(`\r  downloading ${mb(seen)}${total ? ` ${((seen / total) * 100).toFixed(0)}%` : ""}   `);
      }
      callback(null, chunk);
    },
  });
  const reader = res.body.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        yield result.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  await pipeline(Readable.from(chunks()), counter, fs.createWriteStream(dest));
  process.stderr.write("\r" + " ".repeat(40) + "\r");
  return { ok: true, bytes: seen };
}

function extractTarball(file: string, dest: string, version: string): void {
  const listing = spawnSync("tar", ["-tzf", file], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (listing.error) throw new Error(`The tar command is required to unpack indexes: ${listing.error.message}`);
  if (listing.status !== 0) throw new Error(`Unable to list index archive: ${listing.stderr.trim()}`);
  const allowed = new Set(["versions", `versions/${version}`, "registry-entry.json", ...INDEX_FILES.map((name) => `versions/${version}/${name}`)]);
  const paths = listing.stdout.split(/\r?\n/).filter(Boolean);
  for (const name of paths) {
    const normalized = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (path.posix.isAbsolute(name) || name.split("/").includes("..") || name.includes("\\") || !allowed.has(normalized)) throw new Error(`Unexpected index archive entry: ${name}`);
  }
  const verbose = spawnSync("tar", ["-tvzf", file], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (verbose.status !== 0 || verbose.stdout.split(/\r?\n/).filter(Boolean).some((line) => !/^[d-]/.test(line))) {
    throw new Error("Index archives must contain regular files and directories only.");
  }
  const result = spawnSync("tar", ["-xzf", file, "-C", dest], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`tar extraction failed: ${result.error?.message ?? result.status}`);
}

async function main(): Promise<void> {
  const { version: requested, values } = versionArgs(process.argv.slice(2), { out: { type: "string" }, from: { type: "string" }, force: { type: "boolean" } });
  const config = resolveConfig({ bevyVersion: requested });
  const version = requested || config.bevyVersion;
  if (!version) throw new Error("No Bevy version detected. Pass one or point BEVY_PROJECT_ROOT at your Cargo project.");
  stableVersion(version);
  const dataDir = path.resolve(stringOption(values.out) || config.dataDir);
  const repo = process.env.BEVY_MCP_REPO || "kinkirill/bevy_manual_mcp";
  console.log(`bevy-mcp fetch-index - bevy ${version}\n  data dir: ${dataDir}`);
  if (indexPresent(dataDir, version) && values.force !== true) {
    console.log("  index already present. Use --force to re-download.");
    return;
  }
  const url = stringOption(values.from) || `https://github.com/${repo}/releases/download/v${version}/bevy-index-${version}.tar.gz`;
  console.log(`  source  : ${url}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dataDir, ".bevy-index-stage-"));
  try {
    const tarball = path.join(staging, "index.tar.gz");
    const result = await download(url, tarball);
    if (!result.ok) throw new Error(`No index available for ${version} (${result.reason}). Build it with bevy-mcp fetch-docs ${version}, then npm run build-index -- ${version} --force.`);
    console.log(`  received: ${mb(result.bytes)}`);
    extractTarball(tarball, staging, version);
    const entry = readEntry(path.join(staging, "registry-entry.json"), version);
    await validateIndex(path.join(staging, "versions", version), version);
    installIndex(staging, dataDir, entry);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(`\nDone. Index for bevy ${version} installed at ${path.join(dataDir, "versions", version)}.`);
}

main().catch((error: unknown) => { console.error(`[bevy-mcp] ${errorMessage(error)}`); process.exitCode = 1; });
