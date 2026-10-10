#!/usr/bin/env node
/** Download and install a versioned index from the project's GitHub Releases. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveConfig } from "../src/config.js";
import { CACHE_VERSION } from "../src/store.js";
import { errorMessage, isObject, stableVersion, stringOption, versionArgs } from "./cli-utils.mjs";
import { INDEX_FILES, indexPresent, installIndex, readEntry, validateIndex } from "./index-artifacts.mjs";
import { resolveIndexAsset, verifyArchiveDigest } from "./index-release.mjs";

type DownloadResult = { ok: true; bytes: number; sha256: string } | { ok: false; reason: string };

function mb(bytes: number): string { return `${(bytes / 1048576).toFixed(1)} MB`; }

/** Older bundles may record their format only in the version's registry entry. */
function installedFormat(dataDir: string, version: string): number | null {
  const readObject = (file: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return isObject(value) ? value : null;
    } catch { return null; }
  };
  const metadata = readObject(path.join(dataDir, "versions", version, "meta.json"));
  if (typeof metadata?.cache_version === "number" && Number.isInteger(metadata.cache_version)) return metadata.cache_version;
  const registry = readObject(path.join(dataDir, "registry.json"));
  const entry = isObject(registry?.versions) ? registry.versions[version] : undefined;
  return isObject(entry) && typeof entry.cache_version === "number" && Number.isInteger(entry.cache_version)
    ? entry.cache_version : null;
}

function hasInstalledFiles(dataDir: string, version: string): boolean {
  try {
    return ["records.ndjson", "text-index.json"].every((file) => fs.statSync(path.join(dataDir, "versions", version, file)).isFile());
  } catch { return false; }
}

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
  const digest = createHash("sha256");
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      digest.update(chunk);
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
  return { ok: true, bytes: seen, sha256: digest.digest("hex") };
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
  const { version: requested, values } = versionArgs(process.argv.slice(2), {
    out: { type: "string" }, from: { type: "string" }, force: { type: "boolean" },
    "no-recheck": { type: "boolean" }, help: { type: "boolean" },
  });
  if (values.help === true) {
    console.log("Usage: bevy-mcp fetch-index [version] [--out <data-dir>] [--from <archive-url>] [--force] [--no-recheck]\n" +
      "  --force       Re-download an installed index.\n" +
      "  --no-recheck  Keep an installed index whose format version is unknown; known stale formats still update.");
    return;
  }
  const config = resolveConfig({ bevyVersion: requested });
  const version = requested || config.bevyVersion;
  if (!version) throw new Error("No Bevy version detected. Pass one or point BEVY_PROJECT_ROOT at your Cargo project.");
  stableVersion(version);
  const dataDir = path.resolve(stringOption(values.out) || config.dataDir);
  const repo = process.env.BEVY_MCP_REPO || "kinkirill/bevy_manual_mcp";
  console.log(`bevy-mcp fetch-index - bevy ${version}\n  data dir: ${dataDir}`);
  const already = hasInstalledFiles(dataDir, version);
  const format = already ? installedFormat(dataDir, version) : null;
  const stale = already && format !== null && format !== CACHE_VERSION;
  const unknownFormat = already && format === null;
  if (values.force !== true && (indexPresent(dataDir, version) || (unknownFormat && values["no-recheck"] === true))) {
    console.log(unknownFormat ? "  index already present with an unknown format; keeping it because --no-recheck was supplied."
      : `  index already present for ${version} (format v${CACHE_VERSION}). Nothing to do.`);
    console.log("  Use --force to re-download.");
    return;
  }
  if (stale) {
    console.log(`  installed index is format v${format}, this build ships v${CACHE_VERSION}.\n  Re-downloading so you get the republished index.`);
  } else if (unknownFormat) {
    console.log("  installed index does not record a format version, so it may predate this build.\n" +
      "  Re-downloading to be safe. (use --no-recheck to keep it)");
  }
  const explicitSource = stringOption(values.from) || undefined;
  const asset = explicitSource ? null : await resolveIndexAsset(repo, version);
  const url = explicitSource ?? asset!.url;
  console.log(`  source  : ${url}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dataDir, ".bevy-index-stage-"));
  try {
    const tarball = path.join(staging, "index.tar.gz");
    const result = await download(url, tarball);
    if (!result.ok) throw new Error(`No index available for ${version} (${result.reason}). Build it with bevy-mcp fetch-docs ${version}, then npm run build-index -- ${version} --force.`);
    verifyArchiveDigest(asset?.sha256 ?? null, result.sha256);
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
