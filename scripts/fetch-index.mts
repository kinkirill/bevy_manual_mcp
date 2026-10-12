#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveConfig } from "../src/config.js";
import { CACHE_VERSION } from "../src/store.js";
import { errorMessage, isObject, stableVersion, stringOption, versionArgs } from "./cli-utils.mjs";
import { INDEX_FILES, indexPresent, installIndex, readEntry, readRegistry, validateIndex, type RegistryEntry } from "./index-artifacts.mjs";
import { planIndexFetch, resolveIndexRelease, verifyArchiveDigest, type IndexRelease } from "./index-release.mjs";

type DownloadResult = { ok: true; bytes: number; sha256: string } | { ok: false; reason: string };

function mb(bytes: number): string { return `${(bytes / 1048576).toFixed(1)} MB`; }

// Older bundles may record their format only in the version's registry entry.
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

/** Revision of the currently installed bundle, or null when it predates manifests. */
function installedRevision(dataDir: string, version: string): number | null {
  const entry = readRegistry(dataDir).versions[version];
  if (!entry) return null;
  if (typeof entry.revision === "number") return entry.revision;
  if (typeof entry.asset === "string") {
    const match = entry.asset.match(/\+(\d+)\.tar\.gz$/);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function revisionFromName(name: string): number {
  const match = name.match(/\+(\d+)\.tar\.gz$/);
  return match?.[1] ? Number(match[1]) : 0;
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
      "  --no-recheck  Keep an installed index and skip the newer-revision check; known stale formats still update.");
    return;
  }
  const config = resolveConfig({ bevyVersion: requested });
  const version = requested || config.bevyVersion;
  if (!version) throw new Error("No Bevy version detected. Pass one or point BEVY_PROJECT_ROOT at your Cargo project.");
  stableVersion(version);
  const dataDir = path.resolve(stringOption(values.out) || config.dataDir);
  const repo = process.env.BEVY_MCP_REPO || "kinkirill/bevy_manual_mcp";
  console.log(`bevy-mcp fetch-index - bevy ${version}\n  data dir: ${dataDir}`);

  const explicitSource = stringOption(values.from) || undefined;
  const installed = hasInstalledFiles(dataDir, version);
  const format = installed ? installedFormat(dataDir, version) : null;
  const formatKnown = format !== null;
  const formatCurrent = format === CACHE_VERSION;
  const valid = indexPresent(dataDir, version);

  // Only consult the release when the install is otherwise current; a stale or
  // missing index downloads regardless, so the network call would be wasted.
  let release: IndexRelease | null = null;
  let manifestRevision: number | null = null;
  const checkRemote = valid && values.force !== true && values["no-recheck"] !== true && !explicitSource;
  if (checkRemote) {
    try {
      release = await resolveIndexRelease(repo, version);
      manifestRevision = release.manifest?.revision ?? null;
    } catch (error) {
      console.error(`[bevy-mcp] could not check for a newer index revision: ${errorMessage(error)}`);
    }
  }

  const plan = planIndexFetch({
    installed, valid, formatKnown, formatCurrent,
    force: values.force === true,
    noRecheck: values["no-recheck"] === true,
    manifestRevision,
    installedRevision: installed ? installedRevision(dataDir, version) : null,
  });

  if (plan.action === "skip") {
    if (plan.reason === "up-to-date") {
      console.log(`  index already present and up to date${manifestRevision !== null ? ` (revision ${manifestRevision})` : ""}.`);
    } else if (plan.reason === "no-recheck") {
      console.log(formatKnown
        ? `  index already present for ${version} (format v${CACHE_VERSION}). Nothing to do.`
        : "  index already present with an unknown format; keeping it because --no-recheck was supplied.");
    } else {
      console.log(`  index already present for ${version} (format v${CACHE_VERSION}). Could not check for a newer revision.`);
      console.log("  Use --force to re-download.");
    }
    return;
  }

  if (plan.reason === "stale-format") {
    console.log(`  installed index is format v${format}, this build ships v${CACHE_VERSION}.\n  Re-downloading so you get the republished index.`);
  } else if (plan.reason === "unknown-format") {
    console.log("  installed index does not record a format version, so it may predate this build.\n  Re-downloading to be safe. (use --no-recheck to keep it)");
  } else if (plan.reason === "damaged") {
    console.log(`  installed index for ${version} is incomplete or damaged.\n  Re-downloading to repair it.`);
  } else if (plan.reason === "newer-revision") {
    console.log(`  a newer index revision is available (revision ${manifestRevision}). Downloading.`);
  } else if (plan.reason === "forced") {
    console.log("  re-downloading because --force was supplied.");
  }

  if (!release && !explicitSource) release = await resolveIndexRelease(repo, version);
  const asset = explicitSource
    ? { name: explicitSource.split("/").pop() || `bevy-index-${version}.tar.gz`, url: explicitSource, sha256: null }
    : release!.asset;
  const url = asset.url;
  console.log(`  source  : ${url}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dataDir, ".bevy-index-stage-"));
  try {
    const tarball = path.join(staging, "index.tar.gz");
    const result = await download(url, tarball);
    if (!result.ok) throw new Error(`No index available for ${version} (${result.reason}). Build it with bevy-mcp fetch-docs ${version}, then npm run build-index -- ${version} --force.`);
    verifyArchiveDigest(asset.sha256, result.sha256);
    console.log(`  received: ${mb(result.bytes)}`);
    extractTarball(tarball, staging, version);
    const entry = readEntry(path.join(staging, "registry-entry.json"), version);
    await validateIndex(path.join(staging, "versions", version), version);
    const installedEntry: RegistryEntry = {
      ...entry,
      asset: explicitSource ? null : asset.name,
      revision: explicitSource ? null : release?.manifest?.revision ?? revisionFromName(asset.name),
      sha256: result.sha256,
    };
    installIndex(staging, dataDir, installedEntry);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(`\nDone. Index for bevy ${version} installed at ${path.join(dataDir, "versions", version)}.`);
}

main().catch((error: unknown) => { console.error(`[bevy-mcp] ${errorMessage(error)}`); process.exitCode = 1; });
