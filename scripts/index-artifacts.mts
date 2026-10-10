import fs from "node:fs";
import path from "node:path";
import { readNdjson, parseRegistryEntry, type RegistryData, type RegistryEntry } from "../src/registry.js";
import { CACHE_VERSION } from "../src/store.js";
import { parseMetadata } from "../src/types.js";
import { isObject, stableVersion } from "./cli-utils.mjs";

export const INDEX_FILES = ["records.ndjson", "text-index.json", "meta.json"] as const;
export type { RegistryEntry } from "../src/registry.js";
export type IndexRegistry = RegistryData;

function validateText(file: string): void {
  const text: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObject(text) || !Object.values(text).every((value) => typeof value === "string")) throw new Error("Invalid persisted text index.");
}

export function readEntry(file: string, version: string): RegistryEntry {
  const entry = parseRegistryEntry(JSON.parse(fs.readFileSync(file, "utf8")));
  if (entry.version !== version || entry.cache_version !== CACHE_VERSION) {
    throw new Error(`Index registry entry must describe Bevy ${version} with cache format ${CACHE_VERSION}.`);
  }
  return entry;
}

export function readRegistry(dataDir: string): IndexRegistry {
  const file = path.join(dataDir, "registry.json");
  if (!fs.existsSync(file)) return { cache_version: CACHE_VERSION, versions: {} };
  const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isObject(data) || !isObject(data.versions)) throw new Error(`Invalid registry at ${file}.`);
  const versions: Record<string, RegistryEntry> = {};
  for (const [key, entry] of Object.entries(data.versions)) {
    versions[key] = parseRegistryEntry(entry);
  }
  return { cache_version: CACHE_VERSION, versions };
}

export function indexPresent(dataDir: string, version: string): boolean {
  try {
    const dir = path.join(dataDir, "versions", version);
    if (!INDEX_FILES.every((name) => fs.statSync(path.join(dir, name)).isFile())) return false;
    const meta = parseMetadata(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")));
    validateText(path.join(dir, "text-index.json"));
    const entry = readRegistry(dataDir).versions[version];
    return meta.bevy_version === version && meta.cache_version === CACHE_VERSION && entry?.cache_version === CACHE_VERSION;
  } catch {
    return false;
  }
}

export async function validateIndex(dir: string, version: string): Promise<void> {
  for (const file of INDEX_FILES) {
    if (!fs.statSync(path.join(dir, file)).isFile()) throw new Error(`Missing index file ${file}.`);
  }
  const meta = parseMetadata(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")));
  if (meta.bevy_version !== version || meta.cache_version !== CACHE_VERSION) {
    throw new Error(`Index metadata must describe Bevy ${version} with cache format ${CACHE_VERSION}.`);
  }
  validateText(path.join(dir, "text-index.json"));
  let count = 0;
  for await (const record of readNdjson(path.join(dir, "records.ndjson"))) {
    if (record.source !== "rustdoc" || record.bevy_version !== version) {
      throw new Error(`Index records must be rustdoc for Bevy ${version}; found ${record.source} for ${record.bevy_version ?? "unknown"}.`);
    }
    count++;
  }
  if (meta.api_records !== undefined && meta.api_records !== count) {
    throw new Error(`Index API record count mismatch: expected ${meta.api_records}, found ${count}.`);
  }
}

export function installIndex(staging: string, dataDir: string, entry: RegistryEntry): void {
  const version = stableVersion(entry.version);
  if (entry.cache_version !== CACHE_VERSION) throw new Error(`Index cache format must be ${CACHE_VERSION}.`);
  const root = fs.realpathSync(dataDir);
  const stage = fs.realpathSync(staging);
  const relativeStage = path.relative(root, stage);
  if (!relativeStage || relativeStage === ".." || relativeStage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeStage)) {
    throw new Error("Index installation staging must be a child of the data directory.");
  }
  if (fs.existsSync(path.join(root, "versions")) && fs.lstatSync(path.join(root, "versions")).isSymbolicLink()) {
    throw new Error("Index versions directory must not be a symbolic link.");
  }
  dataDir = root;
  staging = stage;
  const incoming = path.join(staging, "versions", version);
  const relativeIncoming = path.relative(staging, fs.realpathSync(incoming));
  if (!relativeIncoming || relativeIncoming === ".." || relativeIncoming.startsWith(`..${path.sep}`) || path.isAbsolute(relativeIncoming) || fs.lstatSync(incoming).isSymbolicLink()) {
    throw new Error("Incoming index must be a directory inside installation staging.");
  }
  const registry = readRegistry(dataDir);
  registry.versions[version] = entry;
  fs.mkdirSync(path.join(dataDir, "versions"), { recursive: true });
  const target = path.join(dataDir, "versions", version);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Installed index directory must not be a symbolic link.");
  const backup = path.join(staging, "previous-version");
  const registryTmp = path.join(dataDir, `.registry-${process.pid}.tmp`);
  const hadPrevious = fs.existsSync(target);
  if (hadPrevious) fs.renameSync(target, backup);
  try {
    fs.renameSync(incoming, target);
    fs.writeFileSync(registryTmp, JSON.stringify(registry, null, 2) + "\n");
    fs.renameSync(registryTmp, path.join(dataDir, "registry.json"));
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (hadPrevious) fs.renameSync(backup, target);
    throw error;
  } finally {
    fs.rmSync(registryTmp, { force: true });
  }
  fs.rmSync(backup, { recursive: true, force: true });
}
