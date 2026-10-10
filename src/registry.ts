/** Persisted, isolated indexes with explicit source ownership for each Bevy version. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { BevyIndex, CACHE_VERSION, cmpVersion, exportTextIndex, importTextIndex, recordWeightOf } from "./store.js";
import { streamRustdoc } from "./ingest/rustdoc.js";
import { ingestWebsite } from "./ingest/markdown.js";
import { ingestExamples } from "./ingest/examples.js";
import { detectDocVersion, log } from "./config.js";
import { errorMessage, isObject, parseJson, parseMetadata, parseRecord,
  type BevyRecord, type IndexConfig, type IndexMetadata, type RustdocRecord, type WebsiteRecord } from "./types.js";

export async function writeNdjson(filePath: string, iterable: Iterable<BevyRecord> | AsyncIterable<BevyRecord>): Promise<number> {
  let count = 0;
  async function* chunks(): AsyncGenerator<string> {
    for await (const record of iterable) { count++; yield JSON.stringify(record) + "\n"; }
  }
  // Pipeline handles early open/write failures and backpressure together.
  await pipeline(Readable.from(chunks()), fs.createWriteStream(filePath, { encoding: "utf8" }));
  return count;
}

export async function* readNdjson(filePath: string): AsyncGenerator<BevyRecord> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let buffer = "";
  try {
    for await (const chunk of stream) {
      if (typeof chunk !== "string") throw new Error("Unexpected binary NDJSON chunk");
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield parseRecord(parseJson(line));
      }
    }
    if (buffer.trim()) yield parseRecord(parseJson(buffer));
  } finally { stream.destroy(); }
}

const entrySchema = z.object({
  version: z.string(), cache_version: z.number().int().optional(), built_at: z.string().optional(),
  records: z.number().int().nonnegative().optional(), symbols: z.number().int().nonnegative().optional(),
  by_kind: z.record(z.string(), z.number().int().nonnegative()).optional(), doc_dir: z.string().nullable().optional(),
}).passthrough();
const registrySchema = z.object({ cache_version: z.number().int(), versions: z.record(z.string(), entrySchema) });
export type RegistryEntry = z.infer<typeof entrySchema>;
export type RegistryData = z.infer<typeof registrySchema>;
export function parseRegistryEntry(value: unknown): RegistryEntry { return entrySchema.parse(value); }
interface VersionSource { docDir: string | null; examplesDir: string | null }

function sanitize(version: string): string {
  // Names are path components, never traversal or arbitrary environment input.
  if (!/^(?:unversioned|\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/.test(version)) {
    throw new Error(`Invalid Bevy version: ${version}`);
  }
  return version;
}
function directoryExists(directory: string | null): directory is string {
  if (!directory) return false;
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

/** Files, sizes and modification times, including deletions and changes below the newest file. */
export function sourceFingerprint(directories: (string | null)[]): string {
  const hash = createHash("sha256");
  for (const directory of directories) {
    hash.update(JSON.stringify(directory));
    if (!directoryExists(directory)) { hash.update("missing"); continue; }
    const visit = (current: string): void => {
      const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "target") continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) {
          const stat = fs.statSync(file);
          hash.update(JSON.stringify([path.relative(directory, file), stat.size, stat.mtimeMs]));
        }
      }
    };
    visit(directory);
  }
  return hash.digest("hex");
}

function atomicWrite(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}

export class VersionRegistry {
  readonly root: string;
  readonly registryPath: string;
  readonly indices = new Map<string, BevyIndex>();
  readonly sources = new Map<string, VersionSource>();
  readonly pending = new Map<string, Promise<BevyIndex>>();
  private readonly failedSources = new Set<string>();
  registry: RegistryData;
  private shared: { fingerprint: string; records: WebsiteRecord[] } | null = null;

  constructor(readonly config: IndexConfig) {
    this.root = path.join(config.dataDir, "versions");
    this.registryPath = path.join(config.dataDir, "registry.json");
    this.registry = this.readRegistry();
    this.sources.set(sanitize(config.bevyVersion ?? "unversioned"), { docDir: config.docDir, examplesDir: config.examplesDir });
  }
  registerSource(version: string, docDir: string, examplesDir: string | null = null): void {
    const key = sanitize(version);
    if (this.pending.has(key)) throw new Error(`Bevy ${version} is currently loading`);
    if (!directoryExists(docDir)) throw new Error(`Documentation directory does not exist: ${docDir}`);
    this.checkProvenance(version, docDir);
    this.sources.set(key, { docDir: path.resolve(docDir), examplesDir: examplesDir ? path.resolve(examplesDir) : null });
    this.failedSources.delete(key);
    this.indices.delete(key);
  }
  readRegistry(): RegistryData {
    try {
      if (fs.existsSync(this.registryPath)) return registrySchema.parse(parseJson(fs.readFileSync(this.registryPath, "utf8")));
    } catch (error) { log(`registry unusable: ${errorMessage(error)}`); }
    return { cache_version: CACHE_VERSION, versions: {} };
  }
  writeRegistry(): void {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    atomicWrite(this.registryPath, this.registry);
  }
  dirFor(version: string): string { return path.join(this.root, sanitize(version)); }
  readPersistedCacheVersion(version: string): number | null {
    const entryVersion = this.registry.versions[sanitize(version)]?.cache_version;
    try {
      const metadata = parseMetadata(parseJson(fs.readFileSync(path.join(this.dirFor(version), "meta.json"), "utf8")));
      if (entryVersion !== undefined && metadata.cache_version !== undefined && entryVersion !== metadata.cache_version) return null;
      return entryVersion ?? metadata.cache_version ?? null;
    } catch { return null; }
  }
  versions(): string[] {
    return [...new Set([...this.sources.keys(), ...Object.values(this.registry.versions).map((entry) => entry.version)])]
      .filter((version) => this.has(version)).sort(compareVersions);
  }
  has(version: string): boolean {
    try {
      const key = sanitize(version);
      if (this.failedSources.has(key)) return false;
      return this.sources.has(key) || Object.values(this.registry.versions).some((entry) => entry.version === version);
    } catch { return false; }
  }

  /** Coalesce concurrent requests so each version is built/loaded only once. */
  async get(version: string, { force = false }: { force?: boolean } = {}): Promise<BevyIndex> {
    const key = sanitize(version);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const existing = this.indices.get(key);
    if (existing && !force) return existing;
    const loading = this.load(version, force);
    this.pending.set(key, loading);
    try { const index = await loading; this.failedSources.delete(key); return index; }
    catch (error) { this.failedSources.add(key); throw error; }
    finally { this.pending.delete(key); }
  }

  private configFor(version: string): IndexConfig {
    const source = this.sources.get(version);
    return { ...this.config, bevyVersion: version === "unversioned" ? null : version,
      versionSource: version === this.config.bevyVersion ? this.config.versionSource : "version registry",
      docDir: source?.docDir ?? null, examplesDir: source?.examplesDir ?? null };
  }
  private checkProvenance(version: string, docDir: string | null): void {
    const detected = detectDocVersion(docDir);
    if (detected && version !== detected.version) {
      throw new Error(`Documentation version mismatch: Bevy ${version} requested, source contains ${detected.version}`);
    }
  }
  sharedWebsite(): WebsiteRecord[] {
    const fingerprint = sourceFingerprint([this.config.websiteDir]);
    if (this.shared?.fingerprint === fingerprint) return this.shared.records;
    const records = ingestWebsite(this.config.websiteDir, null).filter((record) => recordWeightOf(record) > 0);
    this.shared = { fingerprint, records };
    return records;
  }
  private supplement(index: BevyIndex, cfg: IndexConfig): void {
    // A shallow copy gives each isolated index its own provenance/id assignments.
    index.addRecords(this.sharedWebsite().map((record) => ({ ...record, bevy_version: cfg.bevyVersion })));
    index.addRecords(ingestExamples({ examplesDir: cfg.examplesDir, websiteDir: cfg.websiteDir, bevyVersion: cfg.bevyVersion }));
  }
  *versionedRustdoc(docDir: string, version: string): Generator<RustdocRecord> {
    for (const record of streamRustdoc(docDir, version)) {
      record.bevy_version = version;
      yield record;
    }
  }

  private async load(version: string, force: boolean): Promise<BevyIndex> {
    const cfg = this.configFor(version);
    this.checkProvenance(version, cfg.docDir);
    const dir = this.dirFor(version);
    const recordPath = path.join(dir, "records.ndjson");
    const textPath = path.join(dir, "text-index.json");
    const metaPath = path.join(dir, "meta.json");
    const supplemental = sourceFingerprint([cfg.websiteDir, cfg.examplesDir]);
    const currentFormat = this.readPersistedCacheVersion(version) === CACHE_VERSION;
    let cacheError: unknown;
    if (!force && currentFormat && fs.existsSync(recordPath) && fs.existsSync(textPath) && fs.existsSync(metaPath)) {
      try {
        const started = Date.now();
        const metadata = parseMetadata(parseJson(fs.readFileSync(metaPath, "utf8")));
        if (metadata.bevy_version !== cfg.bevyVersion) throw new Error("Persisted index has a different version");
        if (cfg.docDir && metadata.fingerprint !== sourceFingerprint([cfg.docDir])) {
          throw new Error("Rustdoc inputs changed");
        }
        const index = new BevyIndex();
        let apiCount = 0;
        for await (const record of readNdjson(recordPath)) {
          if (record.source !== "rustdoc" || record.bevy_version !== version) throw new Error("Persisted API record has incorrect provenance");
          apiCount++;
          index.addRecords([record]);
        }
        // The count describes the persisted corpus, including legacy tuple fields
        // that addRecords omits. Validate it before accepting a filtered index.
        if (metadata.api_records !== undefined && apiCount !== metadata.api_records) {
          throw new Error("Persisted API record count does not match metadata");
        }
        this.supplement(index, cfg);
        index.buildSymbolTable();
        index.meta = metadata;
        index.stats = index.stats_();
        if (metadata.supplemental_fingerprint === supplemental) {
          const dump = parseJson(fs.readFileSync(textPath, "utf8"));
          index.text = importTextIndex(dump);
          index.searchableIds = new Set(index.records.filter((record) => index._isIndexed(record)).map((record) => record.id));
          if (index.searchableIds.size > 0 && (!isObject(dump) || Object.keys(dump).length === 0)) {
            throw new Error("Persisted text index is empty for a nonempty corpus");
          }
        } else {
          index.meta.supplemental_fingerprint = supplemental;
          index.meta.text_indexed = await index.buildTextIndex();
          index.meta.website_dir = cfg.websiteDir;
          index.meta.examples_dir = cfg.examplesDir;
          index.meta.symbols = index.symbols.size;
          // A cache update is optional once valid API records have been loaded.
          // Stage it as a complete directory, preserving the previous files on failure.
          try { this.refreshCache(version, index); }
          catch (error) { log(`could not refresh persisted supplements: ${errorMessage(error)}`); }
        }
        this.indices.set(version, index);
        log(`version ${version}: loaded ${index.records.length} records in ${Date.now() - started}ms`);
        return index;
      } catch (error) { cacheError = error; log(`version ${version}: persisted index unusable (${errorMessage(error)})`); }
    }

    const active = version === (this.config.bevyVersion ?? "unversioned");
    const hasPersistedApi = fs.existsSync(recordPath) && fs.statSync(recordPath).size > 0;
    if (!directoryExists(cfg.docDir) && (!active || hasPersistedApi || cacheError !== undefined)) {
      throw new Error(`Cannot rebuild Bevy ${version}: matching documentation source is unavailable. Existing cache preserved.`);
    }
    const started = Date.now();
    fs.mkdirSync(this.root, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.root, `.build-${sanitize(version)}-`));
    try {
      const stagedRecords = path.join(staging, "records.ndjson");
      const apiCount = cfg.docDir ? await writeNdjson(stagedRecords, this.versionedRustdoc(cfg.docDir, version)) : 0;
      if (!cfg.docDir) fs.writeFileSync(stagedRecords, "");
      const index = new BevyIndex();
      for await (const record of readNdjson(stagedRecords)) if (recordWeightOf(record) > 0) index.addRecords([record]);
      this.supplement(index, cfg);
      index.buildSymbolTable();
      const textCount = await index.buildTextIndex();
      index.meta = { bevy_version: cfg.bevyVersion, cache_version: CACHE_VERSION,
        fingerprint: sourceFingerprint([cfg.docDir]), supplemental_fingerprint: supplemental,
        version_source: cfg.versionSource, doc_dir: cfg.docDir, website_dir: cfg.websiteDir,
        examples_dir: cfg.examplesDir, project_root: cfg.projectRoot, built_at: new Date().toISOString(),
        build_ms: Date.now() - started, symbols: index.symbols.size, api_records: apiCount, text_indexed: textCount };
      index.stats = index.stats_();
      fs.writeFileSync(path.join(staging, "text-index.json"), JSON.stringify(exportTextIndex(index.text!)));
      fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify(index.meta, null, 2));
      this.commitIndex(version, index, staging);
      this.indices.set(version, index);
      log(`version ${version}: built ${index.records.length} records in ${Date.now() - started}ms`);
      return index;
    } finally { if (fs.existsSync(staging)) this.removeDirectory(staging); }
  }

  private refreshCache(version: string, index: BevyIndex): void {
    fs.mkdirSync(this.root, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.root, `.refresh-${sanitize(version)}-`));
    try {
      fs.copyFileSync(path.join(this.dirFor(version), "records.ndjson"), path.join(staging, "records.ndjson"), fs.constants.COPYFILE_FICLONE);
      if (!index.text) throw new Error("Cannot persist an index without search data");
      fs.writeFileSync(path.join(staging, "text-index.json"), JSON.stringify(exportTextIndex(index.text)));
      fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify(index.meta, null, 2));
      this.commitIndex(version, index, staging);
    } finally { if (fs.existsSync(staging)) this.removeDirectory(staging); }
  }
  private commitIndex(version: string, index: BevyIndex, staging: string): void {
    const destination = this.dirFor(version);
    const backup = this.commitDirectory(staging, destination);
    const previousRegistry: RegistryData = { ...this.registry, versions: { ...this.registry.versions } };
    try { this.persist(version, index); }
    catch (error) {
      this.registry = previousRegistry;
      this.removeDirectory(destination);
      if (backup) fs.renameSync(backup, destination);
      throw error;
    }
    if (backup) {
      try { this.removeDirectory(backup); }
      catch (error) { log(`could not remove previous cache: ${errorMessage(error)}`); }
    }
  }

  private removeDirectory(directory: string): void {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(this.root)) {
      throw new Error(`Refusing to remove a directory outside the version registry: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  private commitDirectory(staging: string, destination: string): string | null {
    const backup = `${destination}.${randomUUID()}.previous`;
    const hadPrevious = fs.existsSync(destination);
    if (hadPrevious) fs.renameSync(destination, backup);
    try { fs.renameSync(staging, destination); }
    catch (error) {
      if (hadPrevious) fs.renameSync(backup, destination);
      throw error;
    }
    return hadPrevious ? backup : null;
  }
  /** Register metadata only after all version files have been committed. */
  persist(version: string, index: BevyIndex): void {
    if (!index.meta) throw new Error("Cannot persist an index without metadata");
    this.registry.versions[sanitize(version)] = { version, cache_version: CACHE_VERSION,
      built_at: index.meta.built_at, records: index.records.length, symbols: index.symbols.size,
      by_kind: index.stats.by_kind, doc_dir: index.meta.doc_dir ?? null };
    this.registry.cache_version = CACHE_VERSION;
    this.writeRegistry();
  }
  invalidate(version: string): void {
    if (this.pending.has(version)) throw new Error(`Bevy ${version} is currently loading`);
    delete this.registry.versions[sanitize(version)];
    this.indices.delete(version);
    this.writeRegistry();
    this.removeDirectory(this.dirFor(version));
  }
}

export function compareVersions(a: string, b: string): number { return cmpVersion(a, b); }
