#!/usr/bin/env node
/**
 * Mirror rustdoc HTML from docs.rs for a pinned Bevy version.
 *
 * Why this exists: `cargo doc -p bevy` takes many minutes and needs the user's
 * whole dependency tree compiled, but `bevy`'s facade crate re-exports the
 * entire public API, so the docs.rs page set for `bevy` alone contains
 * everything an agent needs -- 0.19.0 has ~7,956 item pages.
 *
 * Usage:
 *   node scripts/fetch-docs.mjs 0.19.0
 *   node scripts/fetch-docs.mjs 0.19.0 --out ~/.cache/bevy-mcp/0.19.0
 *   node scripts/fetch-docs.mjs            # reads version from the project
 *
 * It is resumable: existing non-empty files are skipped, so re-running after an
 * interruption continues where it stopped.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { errorMessage, isObject, stableVersion, stringOption, versionArgs } from "./cli-utils.mjs";

const CRATE = "bevy";

// docs.rs is a shared public service and answers HTTP 429 under load. Be a
// good citizen: few workers, a global minimum interval between requests, and
// honour Retry-After. Adjust with FETCH_CONCURRENCY / FETCH_MIN_INTERVAL_MS.
const CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 4);
const MIN_INTERVAL_MS = Number(process.env.FETCH_MIN_INTERVAL_MS || 120);

/** Serialises every request so the whole process respects MIN_INTERVAL_MS. */
let chain = Promise.resolve();
function throttle() {
  const next = chain.then(
    () => new Promise<void>((r) => setTimeout(r, MIN_INTERVAL_MS)),
  );
  chain = next.catch(() => {});
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET with 429/5xx backoff. Returns the body text, or null for 404/permanent
 * failure. `tries` counts attempts, with full jitter so workers don't retry in
 * lockstep and re-trigger the limit.
 */
async function fetchText(url: string, tries = 5): Promise<string | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "bevy-mcp/1.0 (personal docs mirror; respects rate limits)",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === tries) {
        console.error(`  ! network error ${url}: ${errorMessage(err)}`);
        return null;
      }
      await sleep(500 * attempt + Math.random() * 400);
      continue;
    }

    if (res.status === 404) return null;

    if (res.status === 429 || res.status >= 500) {
      if (attempt === tries) {
        console.error(`  ! gave up on ${url} (HTTP ${res.status})`);
        return null;
      }
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = retryAfter
        ? retryAfter * 1000
        : Math.min(30000, 1000 * 2 ** (attempt - 1));
      const jitter = Math.random() * 500;
      console.error(`  ~ HTTP ${res.status}, backing off ${Math.round(backoff + jitter)}ms`);
      await sleep(backoff + jitter);
      continue;
    }

    if (!res.ok) {
      console.error(`  ! HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  }
  return null;
}

async function main() {
  const { version: argVersion, values } = versionArgs(process.argv.slice(2), { out: { type: "string" } });
  const outArg = stringOption(values.out);
  const config = resolveConfig({ bevyVersion: argVersion });
  const version = argVersion || config.bevyVersion;

  if (!version) {
    console.error(
      "No Bevy version given and none detected. Usage: node scripts/fetch-docs.mjs 0.19.0",
    );
    process.exit(1);
  }
  stableVersion(version);
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || !Number.isFinite(MIN_INTERVAL_MS) || MIN_INTERVAL_MS < 0) {
    throw new Error("FETCH_CONCURRENCY must be a positive integer and FETCH_MIN_INTERVAL_MS a nonnegative number.");
  }

  const outRoot = path.resolve(outArg || config.mirrorDir);
  const crateDir = path.join(outRoot, CRATE);
  const manifestFile = path.join(outRoot, ".bevy-mcp-docversion.json");
  if (fs.existsSync(manifestFile)) {
    const previous: unknown = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (!isObject(previous) || previous.version !== version) {
      throw new Error(`The mirror at ${outRoot} belongs to a different or unknown Bevy version. Choose a fresh --out directory.`);
    }
  }
  fs.mkdirSync(crateDir, { recursive: true });

  // Record which version these docs are for, so the server can detect a
  // mismatch against the host project's Cargo.lock instead of silently
  // mislabelling results. Written now (version only) and updated with the page
  // count once discovery finishes.
  const writeManifest = (totalPages: number | null) => {
    try {
      fs.writeFileSync(
        manifestFile,
        JSON.stringify(
          {
            crate: CRATE,
            version,
            source: "docs.rs",
            docs_rs_url: `https://docs.rs/${CRATE}/${version}/${CRATE}/`,
            fetched_at: new Date().toISOString(),
            total_pages: totalPages ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* non-fatal */
    }
  };
  writeManifest(null);

  const base = `https://docs.rs/${CRATE}/${version}/${CRATE}`;
  console.log(`Mirroring docs.rs rustdoc for ${CRATE} ${version}`);
  console.log(`  source: ${base}`);
  console.log(`  target: ${crateDir}\n`);

  // ---- 1. Discover the page list from all.html ---------------------------
  // The page list is cached on disk so a re-run after a rate-limit penalty box
  // does not have to re-fetch the one request we are most likely to be blocked
  // on.
  const listCache = path.join(outRoot, `pages-${version}.json`);
  let pages: string[] | null = null;

  if (fs.existsSync(listCache)) {
    try {
      const cached: unknown = JSON.parse(fs.readFileSync(listCache, "utf8"));
      if (!Array.isArray(cached) || !cached.every((page): page is string => typeof page === "string")) {
        throw new Error("Invalid cached page list.");
      }
      pages = cached;
      console.log(`Using cached page list (${pages.length} pages) from ${listCache}`);
    } catch {
      pages = null;
    }
  }

  if (!pages?.length) {
    console.log("Fetching all.html (page index)... be patient if docs.rs is slow.");
    // all.html is the linchpin of the whole run: give it far more attempts.
    const allHtml = await fetchText(`${base}/all.html`, 10);
    if (!allHtml) {
      console.error(
        `Could not read ${base}/all.html.\n` +
          `docs.rs is rate-limiting (HTTP 429). Wait a few minutes and re-run ` +
          `the same command -- it resumes and only fetches what is missing.\n` +
          `Alternatively, run \`cargo doc -p bevy\` in your Bevy project, which ` +
          `needs no network at all.`,
      );
      process.exit(1);
    }
    const links = new Set<string>();
    for (const m of allHtml.matchAll(/href="([^"#?]+\.html)"/g)) {
      const href = m[1];
      if (!href) continue;
      if (href.startsWith("http") || href.startsWith("/") || href.startsWith("..")) continue;
      if (href === "all.html" || href === "index.html") continue;
      links.add(href);
    }
    pages = [...links].sort();
    try {
      fs.writeFileSync(listCache, JSON.stringify(pages));
    } catch {
      /* non-fatal */
    }
    console.log(`Found ${pages.length} item pages (list cached).`);
  }
  if (!pages) throw new Error("No rustdoc pages were discovered.");

  // Queue items we do not already have, so a resumed run does no work.
  const missing = pages.filter((rel) => {
    try {
      return fs.statSync(path.join(crateDir, rel)).size === 0;
    } catch {
      return true;
    }
  });
  console.log(`\n${missing.length} of ${pages.length} pages still missing.\n`);
  writeManifest(pages.length);

  // ---- 2. Download concurrently, skipping what we already have -----------
  let done = 0;
  let skipped = 0;
  const failures: string[] = [];
  const skippedPre = pages.length - missing.length;
  const queue = [...missing];
  const started = Date.now();

  // Always mirror the crate root too (module index + re-export list).
  const rootTargets = ["index.html"];

  const total = missing.length + rootTargets.length + skippedPre;
  let lastPaint = 0;
  const bar = () => {
    const now = Date.now();
    if (now - lastPaint < 120) return;
    lastPaint = now;
    const seen = done + skipped + failures.length;
    const pct = Math.floor((seen / total) * 100);
    const rate = seen / Math.max(0.001, (now - started) / 1000);
    const eta = Math.round((total - seen) / Math.max(0.001, rate));
    process.stderr.write(
      `\r  [${String(pct).padStart(3)}%] ${String(seen).padStart(5)}/${total}  ` +
        `${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, "0")}s   `,
    );
  };

  async function downloadOne(rel: string) {
    const target = path.join(crateDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const html = await fetchText(`${base}/${rel}`);
    if (html === null) {
      failures.push(rel);
      return false;
    }
    fs.writeFileSync(target, html);
    done++;
    return true;
  }

  async function worker() {
    while (queue.length) {
      const rel = queue.shift();
      if (rel === undefined) break;
      await downloadOne(rel);
      bar();
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker()),
  );
  for (const rel of rootTargets) await downloadOne(rel);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write("\r".padEnd(100) + "\r");
  console.log(`Done in ${secs}s`);
  console.log(`  downloaded: ${done}`);
  console.log(`  skipped (already present): ${skippedPre + skipped}`);
  console.log(`  failed: ${failures.length}`);
  console.log(`\nPoint the MCP server at it with:\n  export BEVY_DOC_DIR=${outRoot}\n`);

  if (failures.length) {
    console.log(
      `${failures.length} page(s) failed (usually docs.rs rate limiting). Re-run the ` +
        `same command to retry only the missing ones:\n` +
        `  node scripts/fetch-docs.mjs ${version} --out ${outRoot}\n`,
    );
    console.log("First few failures:");
    for (const f of failures.slice(0, 5)) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
