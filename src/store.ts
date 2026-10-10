/** Builds cached Bevy indexes with exact-symbol and full-text search. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import FlexSearch from "flexsearch";
import type { Document } from "flexsearch";
import { ingestRustdoc } from "./ingest/rustdoc.js";
import { ingestWebsite } from "./ingest/markdown.js";
import { ingestExamples } from "./ingest/examples.js";
import { log } from "./config.js";
import { errorMessage, isObject, parseJson, parseMetadata, parseRecord,
  type BevyRecord, type IndexedRecord, type SearchHit, type SearchFilters,
  type IndexConfig, type IndexMetadata, type IndexStats, type ResourceQuery, type VersionParts, type VersionBump } from "./types.js";

interface TextPayload { [key: string]: string; id: string; name: string; full_path: string; signature: string; docs: string }
export type TextIndex = Document<TextPayload, false, false>;
export type TextIndexDump = Record<string, string>;
export const TEXT_FIELDS = ["name", "signature", "docs"] as const;
export const TEXT_RESOLUTION = 9;
// Use the same encoder to build and validate persisted postings.
const textEncoder = new FlexSearch.Encoder();
export function encodeTextTokens(text: string): string[] { return textEncoder.encode(text); }
type WeightedRecord = Partial<BevyRecord> & { kind: string };

/** Bump when persisted record shape or content requires rebuilding existing caches. */
export const CACHE_VERSION = 5;

/** Serialize the callback-based FlexSearch export into a keyed dump. */
export function exportTextIndex(flexIndex: TextIndex): TextIndexDump {
  const dump: TextIndexDump = {};
  flexIndex.export((key, data) => {
    dump[key] = data;
  });
  return dump;
}

export function importTextIndex(dump: unknown): TextIndex {
  if (!isObject(dump) || !Object.values(dump).every((value) => typeof value === "string")) {
    throw new Error("Invalid persisted text index");
  }
  // Persisted fields, tokenizer and resolution must match buildTextIndex.
  const flexIndex = new FlexSearch.Document<TextPayload>({
    document: {
      id: "id",
      index: ["name", "signature", "docs"],
      store: false,
    },
    tokenize: "strict",
    resolution: TEXT_RESOLUTION,
  });
  for (const [key, data] of Object.entries(dump || {})) {
    flexIndex.import(key, String(data));
  }
  return flexIndex;
}

/** Strip generics/whitespace so `Query<'_, '_, &T>` and `Query` unify. */
function baseName(name: string | null | undefined) {
  return String(name || "").replace(/<.*$/, "").trim();
}

/**
 * Resolve the defining subcrate from docs.rs links; record.crate identifies the facade.
 * Fall back to record.crate when a source link is unavailable.
 */
export function subCrateOf(r: Pick<BevyRecord, "source_ref" | "crate">): string | null {
  const m = String(r.source_ref || "").match(/docs\.rs\/([a-z0-9_]+)\//);
  return m?.[1] ?? r.crate ?? null;
}

const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "with", "from", "into", "as", "is", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "how", "what", "which", "when", "where", "why",
  "who", "i", "me", "my", "we", "you", "your", "it", "its", "this", "that",
  "these", "those", "can", "could", "should", "would", "will", "make", "makes",
  "made", "use", "uses", "used", "using", "get", "gets", "getting", "want",
  "need", "there", "here", "if", "then", "than", "so", "but", "not", "no",
  "yes", "please", "help", "between",
]);

/** Drop filler words and comparison framing while retaining query subjects. */
function meaningfulTerms(query: string) {
  const comparison = /\b(?:between|versus|vs|compare|comparison)\b/i.test(query);
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t) &&
      (!comparison || !["difference", "differences", "compare", "comparison", "versus", "vs"].includes(t)));
}

function singularTerm(term: string): string {
  if (term.endsWith("ies") && term.length > 4) return term.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|zes)$/.test(term)) return term.slice(0, -2);
  return term.length > 3 && /s$/.test(term) && !/(?:ss|us)$/.test(term) ? term.slice(0, -1) : term;
}

interface QueryFocus { terms: string[]; subjects: string[]; context: string[]; action: "read" | "write" | "create" | null; communication: boolean }
function queryFocus(query: string): QueryFocus {
  const terms = meaningfulTerms(query).map(singularTerm);
  const comparison = /\b(?:difference|compare|comparison|versus|vs)\b/i.test(query);
  const prefix = comparison ? query : query.split(/\b(?:in|with|into|between)\b/i)[0] ?? query;
  let subjects = meaningfulTerms(prefix).map(singularTerm).filter((term) => !INTENT_VERBS.has(term));
  const action = /\b(?:read|reads|reading)\b/i.test(query) ? "read"
    : /\b(?:send|write|emit|sending|writing)\b/i.test(query) ? "write"
    : /\b(?:spawn|create|make|build)\b/i.test(query) ? "create" : null;
  const asksCommunication = terms.some((term) => /^(?:communicate|communication|communicating)$/.test(term));
  const ecsContext = terms.some((term) => term === "system" || term === "ecs");
  const communication = (asksCommunication && ecsContext) ||
    (action !== null && action !== "create" && terms.some((term) => term === "message" || term === "event")) ||
    (comparison && terms.includes("message") && terms.includes("event"));
  if (asksCommunication && ecsContext) subjects = ["message", "event"];
  // Include event and message candidates without assuming a version boundary.
  if (communication && action && subjects.includes("event")) subjects.push("message");
  if (communication && subjects.some((term) => term === "event" || term === "message")) {
    subjects = subjects.filter((term) => term !== "system");
  }
  if (!subjects.length) subjects = terms.filter((term) => !INTENT_VERBS.has(term));
  // Preserve secondary concepts introduced by prepositions, such as a sphere's material.
  const context = terms.filter((term) => !INTENT_VERBS.has(term) && !subjects.includes(term) &&
    !(communication && (term === "system" || term === "ecs")));
  return { terms, subjects: [...new Set(subjects)], context: [...new Set(context)], action, communication };
}

function nameTerms(name: string): string[] {
  return baseName(name).replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singularTerm);
}

/** Normalise symbol spelling while retaining every owner and module component. */
function normKey(s: string) {
  let withoutGenerics = "";
  let depth = 0;
  for (const ch of String(s || "")) {
    if (ch === "<") {
      if (depth === 0 && withoutGenerics.trimEnd().endsWith("::")) withoutGenerics = withoutGenerics.trimEnd().slice(0, -2);
      depth++;
    }
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) withoutGenerics += ch;
  }
  return withoutGenerics
    .replace(/\s+/g, "")
    .replace(/\(\)$/, "")
    .replace(/^::/, "")
    .toLowerCase();
}

/** Fingerprint source paths, file counts and newest modification times. */
function fingerprint({ bevyVersion, docDir, websiteDir, examplesDir }: Pick<IndexConfig, "bevyVersion" | "docDir" | "websiteDir" | "examplesDir">) {
  const parts = [String(CACHE_VERSION), String(bevyVersion)];
  for (const dir of [docDir, websiteDir, examplesDir]) {
    if (!dir || !fs.existsSync(dir)) {
      parts.push("none");
      continue;
    }
    let count = 0;
    let newest = 0;
    const stack = [dir];
    while (stack.length && count < 20000) {
      const cur = stack.pop();
      if (!cur) continue;
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === "target") continue;
          stack.push(full);
        } else {
          count++;
          try {
            const m = fs.statSync(full).mtimeMs;
            if (m > newest) newest = m;
          } catch {
          }
        }
      }
    }
    parts.push(`${dir}:${count}:${Math.round(newest)}`);
  }
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Source and kind weights prioritize API over news; zero weights exclude records. */
const SOURCE_WEIGHT: Record<string, number> = {
  rustdoc: 1.0,
  "bevy-examples": 0.9,
  "learn-examples": 0.85,
  website: 1.0,
};

const KIND_WEIGHT: Record<string, number> = {
  // Low weights keep common fields from dominating concepts; exact lookup still finds them.
  field: 0.45,
  book: 0.7,
  tutorial: 0.7,
  migration_guide: 0.7,
  migration_entry: 0.65,
  release_notes: 0.6,
  faq: 0.55,
  guide: 0.5,
  doc: 0.35,
  news: 0.12,
  foundation: 0,
  donate: 0,
  sponsorship: 0,
};

function recordWeight(r: WeightedRecord) {
  const byKind = KIND_WEIGHT[r.kind];
  if (byKind !== undefined) return byKind;
  return SOURCE_WEIGHT[r.source ?? ""] ?? 0.4;
}

// Share indexing weights and eligibility rules with the registry.
export {
  recordWeight as recordWeightOf,
  KIND_WEIGHT,
  SOURCE_WEIGHT,
  isSearchable,
  DEP_CRATES,
};

/** Scope API and example identities by Bevy version; website identities are shared. */
function isVersionSpecificSource(source: BevyRecord["source"]) {
  return source === "rustdoc" || source === "bevy-examples";
}

/**
 * Select high-value records when onlySearchable is enabled.
 * Exact symbols and resources still expose excluded records.
 */
function isSearchable(r: WeightedRecord) {
  if (r.source !== "rustdoc") return true;

  // Source links identify dependency-defined methods despite facade namespaces.
  if (r.kind === "method" || r.kind === "associated_type") {
    const ref = r.source_ref || "";
    const m = ref.match(/docs\.rs\/([a-z0-9_]+)\//);
    const crate = m ? m[1] : ref.includes("rust-lang.org") ? "std" : null;
    if (crate && (DEP_CRATES.has(crate) || crate === "std")) return false;
  }

  // Keep methods with substantive docs; exact lookup still covers the rest.
  if (r.kind === "method") return !!(r.docs && r.docs.trim().length > 80);

  return true;
}

/** Dependency crates whose methods surface on Bevy types but are not Bevy API. */
const DEP_CRATES = new Set(["glam", "bevy_reflect", "bevy_math"]);

/** Compare numeric version segments, returning -1/0/1 and ignoring prerelease/build suffixes. */
export function cmpVersion(a: string, b: string) {
  const parse = (v: string) =>
    String(v)
      .split("-")[0]!
      .split("+")[0]!
      .split(".")
      .map((seg) => parseInt(seg, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Weight migration and release records against the pinned version, favoring its target guides. */
function versionWeight(r: Partial<BevyRecord>, bevyVersion: string | null | undefined) {
  if (!bevyVersion) return 1;
  const cur = bevyVersion;

  if (r.to_version) {
    const c = cmpVersion(r.to_version, cur);
    if (c === 0) return 2.5;
    if (c < 0) return 0.3;
    return 0.8;
  }
  if (r.from_version) {
    const c = cmpVersion(r.from_version, cur);
    if (c === 0) return 2.0;
    return 0.4;
  }
  if (r.version) {
    const c = cmpVersion(r.version, cur);
    if (c === 0) return 2.0;
    if (c < 0) return 0.3;
    return 0.8;
  }
  return 1;
}

export class BevyIndex {
  records: IndexedRecord[];
  byId: Map<string, IndexedRecord>;
  symbols: Map<string, string[]>;
  text: TextIndex | null;
  meta: IndexMetadata | null;
  stats: IndexStats;
  searchableIds = new Set<string>();
  // Refresh imported postings for identities consolidated from duplicate bundle records.
  readonly repairedIds = new Set<string>();
  constructor() {
    this.records = [];
    this.byId = new Map();
    this.symbols = new Map();
    this.text = null;
    this.meta = null;
    this.stats = { total: 0, by_source: {}, by_kind: {} };
  }

  /** Merge matching identities and assign stable, version-scoped IDs when absent. */
  addRecords(records: Iterable<BevyRecord>) {
    for (const r of records) {
      // Ignore legacy tuple-field rows while retaining v5 bundle compatibility.
      if (r.source === "rustdoc" && r.kind === "field" && /^\d+$/.test(r.name)) continue;
      if (!r.id) {
        const versionScoped = isVersionSpecificSource(r.source) ? r.bevy_version || "?" : "";
        r.id = crypto
          .createHash("sha1")
          .update(
            [r.source, versionScoped, r.kind, r.full_path, r.name, r.heading || ""].join(
              "|",
            ),
          )
          .digest("hex")
          .slice(0, 16);
      }
      const indexed = r as IndexedRecord;
      const existing = this.byId.get(indexed.id);
      if (existing) {
        if (existing.source !== indexed.source || existing.kind !== indexed.kind ||
          existing.full_path !== indexed.full_path || existing.name !== indexed.name ||
          existing.bevy_version !== indexed.bevy_version) {
          throw new Error(`Record ID collision between different API identities: ${indexed.id}`);
        }
        this.repairedIds.add(indexed.id);
        if (indexed.docs.length > existing.docs.length) existing.docs = indexed.docs;
        if (!existing.signature && indexed.signature) existing.signature = indexed.signature;
        if (!existing.source_ref && indexed.source_ref) existing.source_ref = indexed.source_ref;
        if (!existing.defaults && indexed.defaults) existing.defaults = indexed.defaults;
        if (indexed.examples?.length) {
          const examples = new Map((existing.examples ?? []).map((example) => [JSON.stringify(example), example]));
          for (const example of indexed.examples) examples.set(JSON.stringify(example), example);
          existing.examples = [...examples.values()];
        }
        continue;
      }
      this.records.push(indexed);
      this.byId.set(indexed.id, indexed);
    }
  }

  /**
   * Build concrete path, owner-qualified and bare-name aliases.
   * Bare names prefer API definitions over members and macros.
   */
  buildSymbolTable() {
    this.symbols = new Map();
    // Rank ambiguous bare names independently of exact paths.
    const leafCandidates = new Map<string, Map<string, number>>();

    const add = (key: string, id: string, rank?: number) => {
      if (!key) return;
      const k = normKey(key);
      if (!k) return;
      let entry = this.symbols.get(k);
      if (!entry) this.symbols.set(k, (entry = []));
      if (entry.length < 60 && !entry.includes(id)) entry.push(id);
      if (rank !== undefined) {
        let cand = leafCandidates.get(k);
        if (!cand) leafCandidates.set(k, (cand = new Map()));
        const prev = cand.get(id);
        if (prev === undefined || rank < prev) cand.set(id, rank);
      }
    };

    const rankFor = (r: BevyRecord) => {
      switch (r.kind) {
        case "struct":
        case "enum":
        case "trait":
        case "fn":
          return 0;
        case "method":
          return 1;
        case "associated_const":
        case "associated_type":
          return 2;
        default:
          return 3;
      }
    };

    for (const r of this.records) {
      if (r.source !== "rustdoc") continue;
      const leaf = baseName(r.name);
      const owner = baseName(r.owner);
      const rank = rankFor(r);

      // Register only verified aliases so arbitrary owner qualifications cannot collapse.
      const addPath = (fullPath: string) => {
        add(fullPath, r.id, rank);
        const crate = normKey(r.crate || "");
        const key = normKey(fullPath);
        if (crate && key.startsWith(`${crate}::`)) add(key.slice(crate.length + 2), r.id, rank);
      };
      addPath(r.full_path);
      if (owner) add(`${owner}::${leaf}`, r.id, rank);
      if (r.module) {
        if (owner) addPath(`${r.module}::${owner}::${leaf}`);
        else addPath(`${r.module}::${leaf}`);
      }
      add(leaf, r.id, rank);
    }

    for (const [k, cands] of leafCandidates) {
      const ids = this.symbols.get(k);
      if (!ids || ids.length <= 1) continue;
      const order = new Map<string, number>();
      let i = 0;
      for (const id of ids) if (!order.has(id)) order.set(id, i++);
      const sorted = [...cands.entries()].sort((a, b) => a[1] - b[1]);
      // Keep unranked IDs as a fallback.
      for (const [id] of [...order].reverse()) {
        if (!cands.has(id)) sorted.push([id, 99]);
      }
      this.symbols.set(
        k,
        sorted.map(([id]) => id),
      );
    }

    return this.symbols.size;
  }

  /** Append rustdoc records and update an existing text index without rebuilding it. */
  async addRustdocAsync(docDir: string, version: string) {
    const records = ingestRustdoc(docDir, version).filter(
      (r) => recordWeight(r) > 0,
    );
    this.addRecords(records);
    // Add synchronously one payload at a time to avoid duplicating the corpus in memory.
    if (this.text) {
      for (const r of records) {
        if (!this._isIndexed(r)) continue;
        if (r.id) this.text.add(this._flexPayload({ ...r, id: r.id }));
      }
    }
    return records.length;
  }

  /** Map weighted FlexSearch hits to records; relaxed mode drops stopwords and enables suggestions. */
  _searchText(query: string, { limit, allowedIds, relaxed = false, base = 100 }: {
    limit: number; allowedIds: Set<string> | null; relaxed?: boolean; base?: number;
  }): SearchHit[] {
    if (!this.text || !query) return [];
    const q = relaxed ? meaningfulTerms(query).join(" ") : String(query);
    if (!q) return [];
    let raw;
    try {
      raw = this.text.search(q, relaxed ? { limit, suggest: true } : { limit });
    } catch {
      return [];
    }
    // Name matches outrank incidental mentions in documentation.
    const FIELD_WEIGHT: Record<string, number> = { name: 4, signature: 1.5, docs: 1 };
    const out: SearchHit[] = [];
    for (const group of raw || []) {
      const fw = FIELD_WEIGHT[group.field ?? ""] ?? 1;
      let i = 0;
      for (const hit of group.result || []) {
        const id = String(hit);
        if (allowedIds && !allowedIds.has(id)) continue;
        const rec = this.byId.get(id);
        if (rec) {
          // Positive positional decay lets field and name weights dominate ordering.
          out.push({ record: rec, score: (base * fw) / (1 + i * 0.002) });
          i++;
        }
      }
    }
    return out;
  }

  /** Search only within a set of ids (used to isolate one version's items). */
  searchTextScoped(query: string, { limit = 20, allowedIds = null }: { limit?: number; allowedIds?: Set<string> | null } = {}) {
    return this.searchText(query, { limit, allowedIds });
  }

  /** Exclude repetitive fields from full text; exact lookup and owner resources still expose them. */
  _isIndexed(r: BevyRecord) {
    return r.kind !== "field";
  }

  _flexPayload(r: IndexedRecord): TextPayload {
    return {
      id: r.id,
      name: `${r.name} ${baseName(r.name)} ${r.heading || ""} ${r.title || ""} ${(r.categories || []).join(" ")}`,
      full_path: r.full_path || "",
      signature: (r.signature || "").slice(0, 300),
      docs: (r.docs || "").slice(0, 400),
    };
  }

  /**
   * Index names, signatures and docs; omitting paths avoids large posting lists.
   * Paths remain available for exact lookup and filters; onlySearchable enables optional filtering.
   */
  async buildTextIndex({ onlySearchable = false }: { onlySearchable?: boolean } = {}) {
    this.text = new FlexSearch.Document<TextPayload>({
      document: {
        id: "id",
        index: ["name", "signature", "docs"],
        store: false,
      },
      // Whole-term tokens avoid the posting growth caused by prefix indexing.
      tokenize: "strict",
      resolution: TEXT_RESOLUTION,
    });
    const targets = onlySearchable
      ? this.records.filter((r) => isSearchable(r))
      : this.records;

    // Add synchronously, keeping only one payload allocated at a time.
    let added = 0;
    for (const r of targets) {
      if (!this._isIndexed(r)) continue;
      this.text.add(this._flexPayload(r));
      added++;
    }

    this.searchableIds = new Set(targets.filter((r) => this._isIndexed(r)).map((r) => r.id));
    return added;
  }

  /** Exact symbol lookup. Returns records, best match first. */
  lookupSymbol(query: string): SearchHit[] {
    const key = normKey(query);
    if (!key) return [];
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    const qualified = key.includes("::");
    for (const id of this.symbols.get(key) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const record = this.byId.get(id);
      if (!record) continue;
      if (!qualified && normKey(baseName(record.name)) !== key) continue;
      // Full-path matches must lead even when a shorthand alias shares a key.
      const score = qualified && normKey(record.full_path) === key ? 1100 : 1000;
      out.push({ record, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Search text, optionally restricting results to allowedIds. */
  searchText(query: string, { limit = 20, allowedIds = null }: { limit?: number; allowedIds?: Set<string> | null } = {}): SearchHit[] {
    // Combine strict and relaxed matches so natural questions can match useful individual terms.
    const strict = this._searchText(query, { limit, allowedIds, relaxed: false, base: 100 });
    const relaxed = this._searchText(query, { limit, allowedIds, relaxed: true, base: 60 });
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const h of strict) {
      if (seen.has(h.record.id)) continue;
      seen.add(h.record.id);
      out.push(h);
    }
    for (const h of relaxed) {
      if (seen.has(h.record.id)) continue;
      seen.add(h.record.id);
      out.push(h);
    }
    return out;
  }

  stats_() {
    const bySource: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const r of this.records) {
      bySource[r.source] = (bySource[r.source] || 0) + 1;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    return { total: this.records.length, by_source: bySource, by_kind: byKind };
  }
}

function applyFilters(items: SearchHit[], filters: SearchFilters) {
  const {
    kind,
    source,
    module,
    category,
    crate,
    draft,
  } = filters || {};
  const kinds = kind ? String(kind).split(",").map((s) => s.trim()) : null;
  const sources = source ? String(source).split(",").map((s) => s.trim()) : null;
  const cats = category ? String(category).split(",").map((s) => s.trim()) : null;
  const modPrefix = module ? String(module).toLowerCase() : null;

  return items.filter(({ record: r }) => {
    if (kinds && !kinds.some((k) => r.kind === k || (r.kind || "").includes(k)))
      return false;
    if (sources && !sources.includes(r.source)) return false;
    if (crate && r.crate !== crate) return false;
    if (modPrefix && !(r.module || "").toLowerCase().includes(modPrefix))
      return false;
    if (cats && !(r.categories || []).some((c) => cats.includes(c)))
      return false;
    if (draft === false && r.draft) return false;
    return true;
  });
}

/** Enumerate resource records even when they are excluded from full-text search. */
export function queryRecords(index: BevyIndex, query: ResourceQuery): IndexedRecord[] {
  const out: IndexedRecord[] = [];
  for (const r of index.records) {
    if (query.type !== "index" && (r.source === "rustdoc" || r.source === "bevy-examples") && r.bevy_version !== query.version) continue;
    if (query.type === "kind" && r.kind !== query.kind) continue;
    if (query.type === "module" && !(r.module || "").startsWith(query.module)) continue;
    if (query.type === "crate" && subCrateOf(r) !== query.crate) continue;
    if (query.type === "owner" && baseName(r.owner) !== baseName(query.owner)) continue;
    if (query.type === "doc" && r.file !== query.file) continue;
    out.push(r);
  }
  return out;
}

/** Resolve exact paths before suffixes, preferring types and definition sites over macros and reexports. */
export function findByPath(index: BevyIndex, version: string | null, path: string): IndexedRecord | null {
  // Type and derive-macro namespaces can share a path; prefer the API type.
  const symbol = index.lookupSymbol(path).find(({ record }) =>
    record.full_path === path && (!version || record.bevy_version === version));
  if (symbol) return symbol.record;
  const exact = index.records.find(
    (r) => r.full_path === path && (!version || r.bevy_version === version),
  );
  if (exact) return exact;

  const suffix = `::${path}`;
  const matches = index.records.filter(
    (r) =>
      (r.full_path === path || r.full_path.endsWith(suffix)) &&
      (!version || r.bevy_version === version),
  );
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0] ?? null;

  const rank = (r: BevyRecord) =>
    (/^bevy::prelude::/.test(r.full_path) ? 2 : 0) +
    (r.full_path === `bevy::${r.name}` ? 1 : 0);
  const namespaceRank = (r: BevyRecord) => r.kind === "derive" || r.kind === "macro" ? 1 : 0;

  return matches
    .slice()
    .sort(
      (a, b) =>
        namespaceRank(a) - namespaceRank(b) ||
        rank(a) - rank(b) ||
        a.full_path.length - b.full_path.length ||
        a.full_path.localeCompare(b.full_path),
    )[0] ?? null;
}

/** Distinct defining crates in an index, for discovery. */
export function cratesIn(index: BevyIndex): string[] {
  return [...new Set(index.records.map(subCrateOf).filter((crate): crate is string => !!crate))].sort();
}

/** Request verbs receive less weight than subject nouns unless they form the whole query. */
const INTENT_VERBS = new Set([
  "spawn", "despawn", "add", "insert", "remove", "delete", "create", "make",
  "get", "set", "apply", "update", "build", "load", "open", "close", "play",
  "run", "start", "stop", "use", "attach", "register", "send", "emit", "read",
  "write", "enable", "disable", "toggle", "bind", "handle", "process",
  "turn", "communicate", "communication", "communicating", "compare", "difference",
]);

/** Boost subject and type matches above incidental verbs and supporting text matches. */
function relevanceBoost(r: BevyRecord, focus: QueryFocus) {
  if (!focus.terms.length) return 1;
  const leaf = singularTerm(baseName(r.name || "").toLowerCase());
  const leafWords = nameTerms(r.name);
  const ownerWords = nameTerms(r.owner ?? "");
  const pathWords = nameTerms(r.full_path);
  let boost = 1;
  let matched = 0;
  for (const t of new Set([...focus.terms, ...focus.subjects])) {
    const intent = focus.terms.length > 1 && (INTENT_VERBS.has(t) ||
      (!focus.subjects.includes(t) && !focus.context.includes(t)));
    if (leaf === t) {
      boost += intent ? 0.6 : 3;
      matched++;
    } else if (leafWords.includes(t)) {
      boost += intent ? 0.5 : 2.2;
      matched++;
    } else if (t.length > 3 && leaf.includes(t)) {
      boost += intent ? 0.3 : 1.4;
      matched++;
    } else if (pathWords.includes(t)) {
      boost += 0.8;
    } else if (focus.context.includes(t) && new RegExp(`\\b${t}(?:s)?\\b`, "i").test(r.docs)) {
      // Supporting concepts in docs distinguish useful API from empty helpers.
      boost += 0.9;
    }
  }
  if (matched > 1) boost += (matched - 1) * 1.2;
  if (["struct", "enum", "trait", "fn", "type", "primitive"].includes(r.kind)) {
    boost += 0.5;
  }
  const subjectMatch = focus.subjects.some((term) => leafWords.includes(term) || ownerWords.includes(term) || (term.length > 3 && leaf.includes(term)));
  if (subjectMatch && focus.action === "read" && /read/.test(`${leaf} ${r.owner ?? ""}`.toLowerCase())) boost += 3;
  if (subjectMatch && focus.action === "write" && /writ|send|emit/.test(`${leaf} ${r.owner ?? ""}`.toLowerCase())) boost += 3;
  if (focus.communication && r.source === "rustdoc" && /::ecs::/.test(r.full_path)) boost += 2;
  const createsSubject = (["struct", "enum", "trait", "fn", "type", "primitive"].includes(r.kind) && focus.subjects.includes(leaf)) ||
    focus.subjects.includes(singularTerm(baseName(r.owner).toLowerCase()));
  if (subjectMatch && createsSubject && focus.action === "create" && /::(?:math::primitives|mesh::primitives|shape)(?:::|$)/.test(r.full_path)) boost += 2;
  return boost;
}

function definitionKey(record: IndexedRecord): string {
  if (record.source === "rustdoc" && record.source_ref) {
    return [record.source, record.source_ref, record.kind, baseName(record.owner), record.name].join("|");
  }
  return record.id;
}

/** Combine exact symbols and weighted text/subject matches, collapsing reexports. */
export function hybridSearch(
  index: BevyIndex,
  query: string,
  { limit = 8, filters = {}, scope = null }: { limit?: number; filters?: SearchFilters; scope?: Set<string> | null } = {},
): SearchHit[] {
  const cur = index.meta?.bevy_version;
  const weightOf = (r: BevyRecord) => recordWeight(r) * versionWeight(r, cur);
  const hasFilters = Object.values(filters || {}).some(Boolean);
  // Website prose is shared across scopes; API IDs select one version.
  const scoped = (r: IndexedRecord) => !scope || r.source !== "rustdoc" || scope.has(r.id);

  // Fetch a wide pool because FlexSearch applies its limit before our filters and reranking.
  const pool = hasFilters ? Math.max(limit * 100, 3000) : Math.max(limit * 100, 2000);

  const focus = queryFocus(query);
  const exact = applyFilters(index.lookupSymbol(query), filters);
  const seen = new Set();
  const scored: SearchHit[] = [];

  for (const hit of exact) {
    if (seen.has(hit.record.id)) continue;
    if (!scoped(hit.record)) continue;
    seen.add(hit.record.id);
    scored.push({
      record: hit.record,
      score: hit.score * weightOf(hit.record),
    });
  }

  const fuzzy = applyFilters(
    index.searchText(query, { limit: pool, allowedIds: scope }),
    filters,
  ).filter((h) => scoped(h.record));

  // Normalize fuzzy scores to a fixed band while preserving exact-symbol scores.
  const rawById = new Map<string, { record: IndexedRecord; raw: number }>();
  for (const hit of fuzzy) {
    if (seen.has(hit.record.id)) continue;
    const raw = hit.score * weightOf(hit.record) * relevanceBoost(hit.record, focus);
    if (raw <= (rawById.get(hit.record.id)?.raw ?? 0)) continue;
    rawById.set(hit.record.id, {
      record: hit.record,
      raw,
    });
  }
  // Add name/owner matches that FlexSearch's candidate budget may miss.
  const candidateTerms = [...focus.subjects, ...focus.context];
  const includesApi = !filters.source || filters.source.split(",").some((source) => source.trim() === "rustdoc");
  if (!exact.length && candidateTerms.length && includesApi) {
    const names = index.records.filter((record) => {
      if (record.source !== "rustdoc" || record.kind === "field" || seen.has(record.id) || !scoped(record)) return false;
      const words = nameTerms(record.name);
      const owner = nameTerms(record.owner ?? "");
      return candidateTerms.some((term) => words.includes(term) || owner.includes(term));
    });
    for (const record of applyFilters(names.map((record) => ({ record, score: 0 })), filters).map((hit) => hit.record)) {
      const ownMatch = candidateTerms.some((term) => nameTerms(record.name).includes(term));
      const definition = ["struct", "enum", "trait", "fn", "type", "primitive"].includes(record.kind);
      // Definitions outrank incidental noun-containing helpers.
      const raw = (ownMatch && definition ? 240 : 90) * weightOf(record) * relevanceBoost(record, focus);
      if (raw > (rawById.get(record.id)?.raw ?? 0)) rawById.set(record.id, { record, raw });
    }
  }
  const rawFuzzy = [...rawById.values()];
  const maxRaw = rawFuzzy.reduce((m, f) => Math.max(m, f.raw), 0) || 1;
  for (const f of rawFuzzy) {
    scored.push({ record: f.record, score: (f.raw / maxRaw) * 850 });
  }

  scored.sort((a, b) => b.score - a.score);
  const definitions = new Set<string>();
  return scored.filter(({ record }) => {
    if (seen.has(record.id)) return true;
    const key = definitionKey(record);
    if (definitions.has(key)) return false;
    definitions.add(key);
    return true;
  }).slice(0, limit);
}

function buildFromSource(config: IndexConfig) {
  const idx = new BevyIndex();
  const t0 = Date.now();

  const shared = loadSharedWebsiteRecords(config);

  const rustdoc = config.docDir
    ? ingestRustdoc(config.docDir, config.bevyVersion)
    : [];
  idx.addRecords(rustdoc);
  idx.addRecords(shared.website);
  idx.addRecords(
    ingestExamples({
      examplesDir: config.examplesDir,
      websiteDir: config.websiteDir,
      bevyVersion: config.bevyVersion,
    }),
  );

  const kept = idx.records.filter((r) => recordWeight(r) > 0);
  idx.records = kept;
  idx.byId = new Map(kept.map((r) => [r.id, r]));

  idx.buildSymbolTable();

  idx.meta = {
    fingerprint: fingerprint(config),
    bevy_version: config.bevyVersion,
    version_source: config.versionSource,
    doc_dir: config.docDir,
    website_dir: config.websiteDir,
    examples_dir: config.examplesDir,
    project_root: config.projectRoot,
    built_at: new Date().toISOString(),
    build_ms: Date.now() - t0,
    symbols: idx.symbols.size,
  };
  idx.stats = idx.stats_();
  return idx;
}

// Cache unchanged website prose within the process.
let sharedCache: { key: string; website: BevyRecord[] } | null = null;
function loadSharedWebsiteRecords(config: IndexConfig) {
  const key = fingerprint({ ...config, docDir: null, examplesDir: null });
  if (sharedCache?.key === key) return sharedCache;
  const website = config.websiteDir
    ? ingestWebsite(config.websiteDir, config.bevyVersion)
    : [];
  sharedCache = { key, website: website.filter((r) => recordWeight(r) > 0) };
  return sharedCache;
}

export async function loadOrBuild(config: IndexConfig, { force = false }: { force?: boolean } = {}) {
  const started = Date.now();
  const cachePath = path.join(config.dataDir, "index-cache.json");
  const fp = fingerprint(config);

  if (!force && fs.existsSync(cachePath)) {
    try {
      const raw = parseJson(fs.readFileSync(cachePath, "utf8"));
      if (!isObject(raw) || !Array.isArray(raw.records)) throw new Error("Invalid index cache");
      const cached = { meta: parseMetadata(raw.meta), records: raw.records.map((record: unknown) => parseRecord(record)) };
      if (cached.meta?.fingerprint === fp) {
        log(
          `cache hit: ${cached.records.length} records, bevy ${cached.meta.bevy_version}`,
        );
        const idx = new BevyIndex();
        idx.addRecords(cached.records);
        idx.buildSymbolTable();
        await idx.buildTextIndex();
        idx.meta = cached.meta;
        idx.stats = idx.stats_();
        return idx;
      }
      log("cache stale (inputs changed), rebuilding...");
    } catch (err) {
      log("cache unreadable, rebuilding:", errorMessage(err));
    }
  }

  const idx = buildFromSource(config);
  await idx.buildTextIndex();
  if (idx.meta) idx.meta.build_ms = Date.now() - started;

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ meta: idx.meta, records: idx.records }),
    );
    log(
      `index built in ${idx.meta?.build_ms}ms: ${idx.records.length} records, ${idx.meta?.symbols} symbols`,
    );
  } catch (err) {
    log("could not persist cache:", errorMessage(err));
  }
  return idx;
}

/**
 * Return migration chunks between versions, retaining up to perDoc matches per document.
 * Apply topic before ranking so relevant sections are not dropped.
 */
export function findMigrations(index: BevyIndex, from: string | null | undefined, to: string | null | undefined, { topic = null, perDoc = 6 }: { topic?: string | null; perDoc?: number } = {}) {
  const matchesTopic = (r: BevyRecord) =>
    !topic ||
    `${r.name || ""} ${r.heading || ""} ${(r.breadcrumb || []).join(" ")} ${r.docs || ""}`
      .toLowerCase()
      .includes(String(topic).toLowerCase());

  const scored: SearchHit[] = [];
  const push = (r: IndexedRecord, base: number) => {
    if (!matchesTopic(r)) return;
    scored.push({ record: r, score: base * versionWeight(r, index.meta?.bevy_version) });
  };

  for (const r of index.records) {
    if (r.kind === "migration_guide") {
      if (from && to && r.from_version === from && r.to_version === to) push(r, 100);
      else if (to && r.to_version === to) push(r, 70);
      else if (from && r.from_version === from) push(r, 60);
      else continue;
    } else if (r.kind === "migration_entry" && to && r.version === to) {
      push(r, 50);
    } else if (r.kind === "release_notes" && to && r.version === to) {
      push(r, 45);
    } else {
      continue;
    }
  }

  const byDoc = new Map<string, SearchHit[]>();
  for (const item of scored) {
    const key = item.record.full_path;
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key)?.push(item);
  }

  const out: SearchHit[] = [];
  for (const items of byDoc.values()) {
    items.sort((a, b) => b.score - a.score);
    out.push(...items.slice(0, perDoc));
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

export const _internal = {
  normKey,
  baseName,
  fingerprint,
  applyFilters,
  cmpVersion,
  versionWeight,
  recordWeight,
  versionKind,
  bumpBetween,
};

/** Parse semantic version components while ignoring build metadata. */
function versionKind(version: string): VersionParts {
  const clean = String(version || "").split("+")[0] ?? "";
  const [core, pre] = clean.split("-");
  const nums = (core ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  return {
    major: nums[0] || 0,
    minor: nums[1] || 0,
    patch: nums[2] || 0,
    prerelease: pre || null,
    raw: clean,
  };
}

/** Classify direction, release level and API compatibility; Bevy 0.x minor bumps are breaking. */
function bumpBetween(from: string | null | undefined, to: string | null | undefined): VersionBump {
  if (!from || !to) {
    return { level: "unknown", breaksApi: true, direction: "unknown", label: "unknown" };
  }
  const a = versionKind(from);
  const b = versionKind(to);
  const cmp = cmpVersion(from, to);

  if (cmp === 0) {
    return {
      level: "none",
      breaksApi: false,
      direction: "same",
      label: `${to} is the same version as ${from}`,
      from: a,
      to: b,
    };
  }

  const direction = cmp < 0 ? "upgrade" : "downgrade";

  if (cmp > 0) {
    return {
      level: "downgrade",
      breaksApi: true,
      direction,
      label: `${from} -> ${to} is a downgrade; the ${from} APIs no longer exist.`,
      from: a,
      to: b,
    };
  }

  if (a.major === 0 && b.major === 0 && a.minor !== b.minor) {
    return {
      level: "minor",
      breaksApi: true,
      direction,
      label:
        `${from} -> ${to} is a MINOR bump: Bevy makes sweeping breaking API ` +
        `changes at every minor release. Expect substantial rewrites.`,
      from: a,
      to: b,
    };
  }

  if (a.major !== b.major) {
    return {
      level: "major",
      breaksApi: true,
      direction,
      label: `${from} -> ${to} is a MAJOR bump and definitely breaks the API.`,
      from: a,
      to: b,
    };
  }

  if (a.minor !== b.minor) {
    return {
      level: "minor",
      breaksApi: a.major === 0,
      direction,
      label:
        a.major === 0
          ? `${from} -> ${to} is a minor bump on a 0.x version: breaking API changes.`
          : `${from} -> ${to} is a minor bump; on a 1.x+ release this is additive, not breaking.`,
      from: a,
      to: b,
    };
  }

  return {
    level: "patch",
    breaksApi: false,
    direction,
    label:
      `${from} -> ${to} is a PATCH release: bug fixes only, no API changes. ` +
      `Existing code keeps working; there is nothing to migrate.`,
    from: a,
    to: b,
  };
}

export { versionKind, bumpBetween };
