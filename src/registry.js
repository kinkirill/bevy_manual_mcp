/**
 * Version registry: keeps one fully-built index per Bevy version, on disk.
 *
 * Design notes
 * ------------
 * Self-renewal needs cheap access to *several* versions at once: the version a
 * project is pinned to, plus whatever new release just appeared. Building a
 * fresh FlexSearch index takes seconds, so each version's index is persisted
 * and reloaded on demand rather than rebuilt at startup.
 *
 * Website prose (book, migration guides) is version-independent, so it is
 * parsed once and shared across all versions instead of being re-ingested.
 */

import fs from "node:fs";
import path from "node:path";

import {
  BevyIndex,
  loadOrBuild,
  exportTextIndex,
  importTextIndex,
  recordWeightOf,
  CACHE_VERSION,
} from "./store.js";
import { streamRustdoc } from "./ingest/rustdoc.js";
import { ingestWebsite } from "./ingest/markdown.js";
import { ingestExamples } from "./ingest/examples.js";
import { log } from "./config.js";

/**
 * Write NDJSON (one JSON record per line) by streaming a generator to disk.
 *
 * This is the memory-safe way to persist a large ingest: the records never all
 * exist in memory at once, and the file can be read back with a streaming
 * parser instead of JSON.parse on a multi-hundred-megabyte string.
 */
export async function writeNdjson(filePath, iterable) {
  const out = fs.createWriteStream(filePath, { encoding: "utf8" });
  let count = 0;
  // Backpressure matters: without awaiting drain, a fast generator buffers
  // faster than disk writes and we lose the memory win we came here for.
  const write = (chunk) =>
    out.write(chunk) ? Promise.resolve() : new Promise((r) => out.once("drain", r));

  for await (const rec of iterable) {
    await write(JSON.stringify(rec) + "\n");
    count++;
  }
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  return count;
}

/** Read NDJSON back, yielding records one at a time. */
export async function* readNdjson(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

const VER_DIR = "versions";
const REGISTRY = "registry.json";

function sanitize(version) {
  return String(version).replace(/[^a-zA-Z0-9._+-]/g, "_");
}

export class VersionRegistry {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.dataDir, VER_DIR);
    this.registryPath = path.join(config.dataDir, REGISTRY);
    this.indices = new Map(); // version -> BevyIndex
    this.registry = this.readRegistry();
  }

  readRegistry() {
    try {
      if (fs.existsSync(this.registryPath)) {
        return JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
      }
    } catch {
      /* rebuild below */
    }
    return { cache_version: CACHE_VERSION, versions: {} };
  }

  writeRegistry() {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2));
    } catch (err) {
      log("could not write registry:", err.message);
    }
  }

  dirFor(version) {
    return path.join(this.root, sanitize(version));
  }

  /** Versions we have an index for, newest last. */
  versions() {
    return Object.keys(this.registry.versions).sort(compareVersions);
  }

  has(version) {
    return !!this.registry.versions[sanitize(version)];
  }

  /** Build (or load) the index for one version. */
  async get(version, { force = false } = {}) {
    const key = sanitize(version);
    if (this.indices.has(key) && !force) return this.indices.get(key);

    const isActive = String(version) === String(this.config.bevyVersion);
    const cfg = isActive
      ? this.config
      : { ...this.config, bevyVersion: version, docDir: this.config.docDir };

    const dir = this.dirFor(version);
    const textPath = path.join(dir, "text-index.json");
    const metaPath = path.join(dir, "meta.json");
    const recPath = path.join(dir, "records.ndjson");

    // Fast path: a previously persisted index for this exact version.
    if (
      !force &&
      fs.existsSync(textPath) &&
      fs.existsSync(recPath) &&
      fs.existsSync(metaPath)
    ) {
      try {
        const t0 = Date.now();
        const idx = new BevyIndex();
        // Stream from NDJSON so loading a 200k-record version does not itself
        // blow the heap the way JSON.parse of one giant array would. Records are
        // added one at a time, so they must be wrapped: addRecords() takes an
        // iterable, and a bare record is not one.
        for await (const rec of readNdjson(recPath)) idx.addRecords([rec]);
        // records.ndjson holds only the version-specific rustdoc stream. The
        // version-independent website prose (book, migration guides, release
        // notes) and the examples are parsed in memory during a build but never
        // written to that file, so a warm start must re-add them or it silently
        // loses every non-rustdoc record while the persisted text index still
        // advertises their ids.
        idx.addRecords(this.sharedWebsite());
        idx.addRecords(
          ingestExamples({
            examplesDir: cfg.examplesDir,
            websiteDir: cfg.websiteDir,
            bevyVersion: version,
          }),
        );
        idx.buildSymbolTable();
        idx.text = importTextIndex(JSON.parse(fs.readFileSync(textPath, "utf8")));
        idx.meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        idx.stats = idx.stats_();
        log(`version ${version}: loaded persisted index in ${Date.now() - t0}ms`);
        this.indices.set(key, idx);
        return idx;
      } catch (err) {
        log(`version ${version}: persisted index unusable (${err.message}), rebuilding`);
      }
    }

    log(`version ${version}: building index...`);
    const t0 = Date.now();
    fs.mkdirSync(dir, { recursive: true });

    // Pass 1: stream rustdoc straight to disk. Never held in memory.
    const shared = this.sharedWebsite();
    let apiCount = 0;
    if (cfg.docDir) {
      apiCount = await writeNdjson(recPath, this.versionedRustdoc(cfg.docDir, version));
      log(`version ${version}: wrote ${apiCount} rustdoc records to disk`);
    } else {
      fs.writeFileSync(recPath, "");
    }

    // Pass 2: re-read from disk and feed the in-memory structures. Reading back
    // is far cheaper than parsing HTML again, and keeps peak memory to one
    // page's worth at a time.
    const idx = new BevyIndex();
    let keptCount = 0;
    for await (const rec of readNdjson(recPath)) {
      if (recordWeightOf(rec) <= 0) continue;
      idx.addRecords([rec]);
      keptCount++;
    }
    log(`version ${version}: loaded ${keptCount} rustdoc records into memory`);
    idx.addRecords(shared);
    idx.addRecords(
      ingestExamples({
        examplesDir: cfg.examplesDir,
        websiteDir: cfg.websiteDir,
        bevyVersion: version,
      }),
    );

    idx.buildSymbolTable();

    // The full corpus fits now that `full_path` is no longer an indexed field
    // (see BevyIndex.buildTextIndex), so nothing is curated out of search.
    // Completeness holds in all three layers: records, exact symbols, resources.
    const textCount = await idx.buildTextIndex();

    idx.meta = {
      bevy_version: version,
      version_source: cfg.versionSource,
      doc_dir: cfg.docDir,
      website_dir: cfg.websiteDir,
      examples_dir: cfg.examplesDir,
      project_root: cfg.projectRoot,
      built_at: new Date().toISOString(),
      build_ms: Date.now() - t0,
      symbols: idx.symbols.size,
      api_records: apiCount,
      text_indexed: textCount,
    };
    idx.stats = idx.stats_();

    this.persist(version, idx);
    this.indices.set(key, idx);
    return idx;
  }

  /** Tag rustdoc records with the version while streaming. */
  *versionedRustdoc(docDir, version) {
    for (const rec of streamRustdoc(docDir, version)) {
      rec.bevy_version = version;
      yield rec;
    }
  }

  /** Website prose is version-independent: parse once, share everywhere. */
  sharedWebsite() {
    if (this._shared) return this._shared;
    const t0 = Date.now();
    const website = this.config.websiteDir
      ? ingestWebsite(this.config.websiteDir, this.config.bevyVersion)
      : [];
    this._shared = website.filter((r) => recordWeightOf(r) > 0);
    log(
      `shared website prose: ${this._shared.length} records parsed in ${Date.now() - t0}ms`,
    );
    return this._shared;
  }

  persist(version, idx) {
    const dir = this.dirFor(version);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // records.ndjson was already streamed to disk during the build; only the
      // search index and metadata need writing now.
      fs.writeFileSync(
        path.join(dir, "text-index.json"),
        JSON.stringify(exportTextIndex(idx.text)),
      );
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(idx.meta, null, 2));
      this.registry.versions[sanitize(version)] = {
        version,
        built_at: idx.meta.built_at,
        records: idx.records.length,
        symbols: idx.symbols.size,
        by_kind: idx.stats.by_kind,
        doc_dir: this.config.docDir,
      };
      this.registry.cache_version = CACHE_VERSION;
      this.writeRegistry();
    } catch (err) {
      log(`could not persist index for ${version}:`, err.message);
    }
  }

  /** Invalidate a version so the next get() rebuilds it. */
  invalidate(version) {
    const key = sanitize(version);
    delete this.registry.versions[key];
    this.indices.delete(key);
    this.writeRegistry();
    const dir = this.dirFor(version);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Order versions numerically, ignoring pre-release suffixes. */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export { compareVersions };