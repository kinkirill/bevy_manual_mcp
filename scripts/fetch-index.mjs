#!/usr/bin/env node
/**
 * Download a prebuilt search index from this project's GitHub Releases.
 *
 * Why this exists: building the index from rustdoc takes ~15 minutes (after a
 * ~15 minute docs.rs mirror), which is a terrible first-run experience. The
 * index for a given Bevy minor is identical for everyone, so it is built once
 * and published as a release asset (~74 MB compressed). This script fetches it
 * into the data directory, which turns first run into a short download.
 *
 * Usage:
 *   node scripts/fetch-index.mjs                 # version from config/Cargo.lock
 *   node scripts/fetch-index.mjs 0.20.0
 *   node scripts/fetch-index.mjs 0.20.0 --out ./data
 *   node scripts/fetch-index.mjs 0.20.0 --force  # re-download even if present
 *   node scripts/fetch-index.mjs 0.20.0 --from <tarball-url>
 *
 * Fallback when no release asset exists for a version: mirror docs and build
 * locally, which is slower but always works:
 *   node scripts/fetch-docs.mjs <version>
 *   node scripts/build-index.mjs <version> --force
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { resolveConfig } from "../src/config.js";
import { CACHE_VERSION } from "../src/store.js";

const DEFAULT_REPO = "kinkirill/bevy_manual_mcp";

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : null;
  };
  return {
    version: positional[0] || null,
    out: opt("--out"),
    from: opt("--from"),
    force: argv.includes("--force"),
    // Escape hatch for the "format unknown -> re-download" branch, for anyone
    // who deliberately wants to keep an index built locally.
    noRecheck: argv.includes("--no-recheck"),
  };
}

/** Human-readable byte count. */
function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Candidate download URLs for one version, newest first.
 *
 * A republished index keeps the same Bevy version and therefore the same tag, so
 * the only way to distinguish "the bundle from last month" from "the one we
 * shipped today" is the filename. A rebuild is published as
 * `bevy-index-<version>+1.tar.gz`, so the suffix doubles as a build marker:
 * users can see which build they have, and a stale asset left in place is
 * obvious rather than indistinguishable.
 *
 * The unsuffixed name is kept as a fallback so an index published before this
 * convention still downloads, and so a reader following an older URL is not
 * left with a 404.
 */
function assetUrls(repo, version) {
  const base = `https://github.com/${repo}/releases/download/v${version}/bevy-index-${version}`;
  return [`${base}+1.tar.gz`, `${base}.tar.gz`];
}

/** Stream a URL to a file, painting a simple progress line on stderr. */
async function download(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": "bevy-mcp/fetch-index" },
    redirect: "follow",
  });

  if (res.status === 404) {
    return { ok: false, reason: "not-found" };
  }
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = dest + ".part";
  let seen = 0;
  let lastPaint = 0;

  // A counting Transform in the pipeline gives progress without the web-stream
  // async iteration that trips an undici assertion under backpressure.
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        const pct = total ? ` ${((seen / total) * 100).toFixed(0)}%` : "";
        process.stderr.write(`\r  downloading ${mb(seen)}${pct}   `);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  process.stderr.write("\r" + " ".repeat(40) + "\r");

  fs.renameSync(tmp, dest);
  return { ok: true, bytes: seen };
}

function extractTarball(file, dest) {
  const probe = spawnSync("tar", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    throw new Error(
      "the `tar` command is required to unpack the index. Install tar, or " +
        "mirror docs and build locally instead (see fetch-docs.mjs).",
    );
  }
  const r = spawnSync("tar", ["-xzf", file, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`tar failed with exit code ${r.status}`);
  }
}

/** Merge one version's registry entry into data/registry.json, keeping others. */
function mergeRegistry(dataDir, entryFile) {
  const registryPath = path.join(dataDir, "registry.json");
  let registry = { cache_version: CACHE_VERSION, versions: {} };
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (!registry.versions) registry.versions = {};
  } catch {
    /* start fresh */
  }
  const entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
  const key = String(entry.version).replace(/[^a-zA-Z0-9._+-]/g, "_");
  registry.versions[key] = entry;
  // The registry-level field must track the current format, not the one in
  // force when the bundle was published: it is what a later run compares
  // against to decide whether this index needs rebuilding.
  registry.cache_version = CACHE_VERSION;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  const version = args.version || config.bevyVersion;
  const dataDir = path.resolve(
    args.out || config.dataDir || path.join(os.homedir(), ".cache", "bevy-mcp", "data"),
  );
  const repo = process.env.BEVY_MCP_REPO || DEFAULT_REPO;

  if (!version) {
    console.error(
      "No Bevy version given and none detected.\n" +
        "  Pass one:      node scripts/fetch-index.mjs 0.20.0\n" +
        "  Or set:        BEVY_VERSION=0.20.0\n" +
        "  Or point at a Cargo project with BEVY_PROJECT_ROOT.",
    );
    process.exit(1);
  }

  const sanitized = String(version).replace(/[^a-zA-Z0-9._+-]/g, "_");
  const versionDir = path.join(dataDir, "versions", sanitized);
  const already =
    fs.existsSync(path.join(versionDir, "records.ndjson")) &&
    fs.existsSync(path.join(versionDir, "text-index.json"));

  console.log(`bevy-mcp fetch-index - bevy ${version}`);
  console.log(`  data dir: ${dataDir}`);

  // Present-but-old is the interesting case. A republished index has the same
  // version and therefore the same install path, so without this check a user
  // who installed the previous build would be told "nothing to do" and keep
  // using a stale corpus forever. Compare the format version the same way
  // VersionRegistry does on load.
  let installedCacheVersion = null;
  try {
    const metaPath = path.join(versionDir, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (typeof meta.cache_version === "number") installedCacheVersion = meta.cache_version;
    }
    if (installedCacheVersion === null) {
      const registry = JSON.parse(
        fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"),
      );
      const entry = registry?.versions?.[sanitized];
      if (entry && typeof entry.cache_version === "number") {
        installedCacheVersion = entry.cache_version;
      }
    }
  } catch {
    /* unreadable registry or meta: fall through to the "already" check */
  }

  const stale = already && installedCacheVersion !== null && installedCacheVersion !== CACHE_VERSION;
  const unknownFormat = already && installedCacheVersion === null && !args.noRecheck;

  if (already && !args.force && !stale && !unknownFormat) {
    console.log(`  index already present for ${version} (format v${CACHE_VERSION}). Nothing to do.`);
    console.log(`  (use --force to re-download)`);
    return;
  }
  if (stale) {
    console.log(
      `  installed index is format v${installedCacheVersion}, this build ships v${CACHE_VERSION}.`,
    );
    console.log(`  Re-downloading so you get the republished index.`);
  } else if (unknownFormat) {
    console.log(
      `  installed index does not record a format version, so it may predate this build.`,
    );
    console.log(`  Re-downloading to be safe. (use --no-recheck to keep it)`);
  }

  // With an explicit --from there is nothing to fall back from, so use it as
  // given. Otherwise try the "+1" rebuild marker first, then the unsuffixed
  // name for indexes published before that convention.
  const candidates = args.from ? [args.from] : assetUrls(repo, version);
  const tmpFile = path.join(os.tmpdir(), `bevy-index-${sanitized}-${process.pid}.tar.gz`);
  let result = null;
  let usedUrl = null;
  const failures = [];

  for (const url of candidates) {
    console.log(`  source  : ${url}`);
    try {
      const r = await download(url, tmpFile);
      if (r.ok) {
        result = r;
        usedUrl = url;
        break;
      }
      failures.push(`${url} -> ${r.reason}`);
      // A 404 on the "+1" name is expected for an index that has not been
      // republished; anything else (network, 5xx) is worth trying the other
      // candidate for, since the unsuffixed asset may still exist.
    } catch (err) {
      failures.push(`${url} -> ${err.message}`);
    }
  }

  if (!result?.ok) {
    console.error(
      `\nCould not download a prebuilt index for ${version}.\n` +
        (failures.length ? `  tried:\n${failures.map((f) => `    ${f}`).join("\n")}\n` : "") +
        `\nBuild it locally instead:\n` +
        `  node scripts/fetch-docs.mjs ${version}\n` +
        `  node scripts/build-index.mjs ${version} --force\n\n` +
        `If you maintain this project, publish one with:\n` +
        `  node scripts/publish-index.mjs ${version}\n` +
        `and attach it to the v${version} GitHub Release.`,
    );
    process.exit(1);
  }

  console.log(`  received: ${mb(result.bytes)} from ${usedUrl.split("/").pop()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    extractTarball(tmpFile, dataDir);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  const entryFile = path.join(dataDir, "registry-entry.json");
  if (fs.existsSync(entryFile)) {
    mergeRegistry(dataDir, entryFile);
    fs.rmSync(entryFile, { force: true });
  }

  console.log(`\nDone. Index for bevy ${version} installed at ${versionDir}.`);
  console.log(`Start the server:  bevy-mcp   (or: node index.js)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
