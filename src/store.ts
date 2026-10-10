/**
 * Index store: build, cache, and query the Bevy record set.
 *
 * Two complementary lookup paths, because neither alone is good enough:
 *   1. An exact symbol table. API questions look like `Query::iter`, and a
 *      purely fuzzy index ranks prose above the function you asked for.
 *   2. A FlexSearch full-text index for concepts, tasks and prose.
 */

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
type WeightedRecord = Partial<BevyRecord> & { kind: string };

/**
 * Bump whenever the *shape or content* of a persisted record changes, so a
 * previously built index is rebuilt instead of being served as current.
 *
 * History: 4 = rustdoc records streamed to NDJSON, per-version registry. 5 =
 * struct fields added to the corpus (they are not reachable by an older index,
 * and their weights changed, so serving a v4 index would answer field queries
 * as "no such item" while the server claimed to be current).
 */
export const CACHE_VERSION = 5;

/**
 * Serialize the FlexSearch index to a plain object.
 *
 * FlexSearch's export() takes a callback (it does not return a value), and
 * import() is per-key. Persisting this turns a 7.3s rebuild into a ~0.7s load,
 * which is what makes holding several Bevy versions at once practical.
 */
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
  // NOTE: this field list AND tokenizer must stay in sync with
  // BevyIndex.buildTextIndex, because an export encodes field names in its keys
  // and the tokenizer is baked into the exported maps. `full_path` stays out of
  // the index: it is high-cardinality with no ranking value.
  const flexIndex = new FlexSearch.Document<TextPayload>({
    document: {
      id: "id",
      index: ["name", "signature", "docs"],
      store: false,
    },
    tokenize: "strict",
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
 * The Bevy sub-crate a record was actually defined in.
 *
 * The mirrored rustdoc is the `bevy` facade only, so `record.crate` is always
 * "bevy" even though most items are defined in `bevy_app`, `bevy_ecs`, etc. The
 * only place that information survives the facade re-export is the rustdoc
 * source link, which points at the defining crate on docs.rs. Falls back to
 * `record.crate` when there is no source link (variants, some re-exported
 * items), so `bevy://crate/<v>/bevy` still returns the facade remainder.
 */
export function subCrateOf(r: Pick<BevyRecord, "source_ref" | "crate">): string | null {
  const m = String(r.source_ref || "").match(/docs\.rs\/([a-z0-9_]+)\//);
  return m?.[1] ?? r.crate ?? null;
}

/**
 * Filler words that carry no search intent.
 *
 * FlexSearch matches multi-term queries with AND semantics by default, so a
 * natural-language query like "how do I spawn a 2d camera" requires *every*
 * token to appear in one document and therefore matches nothing. Dropping the
 * filler and retrying in suggestion (OR) mode is what makes those queries work.
 */
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "with", "from", "into", "as", "is", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "how", "what", "which", "when", "where", "why",
  "who", "i", "me", "my", "we", "you", "your", "it", "its", "this", "that",
  "these", "those", "can", "could", "should", "would", "will", "make", "makes",
  "made", "use", "uses", "used", "using", "get", "gets", "getting", "want",
  "need", "there", "here", "if", "then", "than", "so", "but", "not", "no",
  "yes", "please", "help",
]);

/** Keep only the tokens of a query that carry intent. */
function meaningfulTerms(query: string) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t));
}

/** Normalise a lookup key: drop leading path, generics, whitespace, case. */
function normKey(s: string) {
  return String(s || "")
    .replace(/<\s*[^>]*\s*>/g, "")
    .replace(/\s+/g, "")
    .replace(/^[a-z_][a-z0-9_]*::/i, "")
    .toLowerCase();
}

/** Cheap fingerprint of every input, so we skip re-parsing when nothing changed. */
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
            /* ignore */
          }
        }
      }
    }
    parts.push(`${dir}:${count}:${Math.round(newest)}`);
  }
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Relative importance of each record. Bevy API docs must outrank a blog post
 * about the engine, otherwise a concept query returns news items instead of
 * documentation. Records scoring 0 are dropped from the index entirely.
 *
 * `source` weights cover code (rustdoc, examples); `kind` weights cover the
 * website, where every record shares the same source.
 */
const SOURCE_WEIGHT: Record<string, number> = {
  rustdoc: 1.0,
  "bevy-examples": 0.9,
  "learn-examples": 0.85,
  website: 1.0,
};

const KIND_WEIGHT: Record<string, number> = {
  // Struct fields are indexed but deliberately low weight. Without an entry
  // here they would fall through to SOURCE_WEIGHT.rustdoc = 1.0, and ~10-15k
  // full-weight records named `x`, `y`, `z`, `translation` or `scale` would
  // crowd real API out of concept queries. They stay reachable by exact lookup
  // and `bevy://owner/...`, which is where "what fields does X have" resolves.
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

// Re-exported under a public name so the registry can share the same
// "is this record worth indexing?" decision.
export {
  recordWeight as recordWeightOf,
  KIND_WEIGHT,
  SOURCE_WEIGHT,
  isSearchable,
  DEP_CRATES,
};

/**
 * Website prose is version-independent, so it deliberately shares ids across
 * versions and is stored once. Rustdoc is version-specific and gets ids that
 * include the version.
 */
function isVersionSpecificSource(source: BevyRecord["source"]) {
  return source === "rustdoc" || source === "bevy-examples";
}

/**
 * Should this record be in the full-text index?
 *
 * The full-text index exists to answer intent-shaped questions ("how do I
 * create a sphere with colour"). That means it needs prose and high-value API,
 * and it does not need the bulk of derive/trait boilerplate. Records excluded
 * here are NOT dropped from the corpus: they remain readable by resource URI and
 * resolvable through the exact symbol table, so nothing becomes unreachable.
 *
 * Criteria, in order:
 *   - drop dependency-defined methods (glam, bevy_reflect, bevy_math codegen)
 *   - keep all prose (book, tutorials, migration notes, examples)
 *   - keep API whose docs actually explain something
 *   - keep all types, traits, functions and constants (small, high value)
 */
function isSearchable(r: WeightedRecord) {
  if (r.source !== "rustdoc") return true; // all website prose + examples

  // Methods on bevy types that are actually defined by a dependency are noise
  // for intent search: `Vec3::x` via a Bevy wrapper, or `#[derive(Reflect)]`
  // codegen. Decided from the item's own source link, not by name matching.
  if (r.kind === "method" || r.kind === "associated_type") {
    const ref = r.source_ref || "";
    const m = ref.match(/docs\.rs\/([a-z0-9_]+)\//);
    const crate = m ? m[1] : ref.includes("rust-lang.org") ? "std" : null;
    // `std` counts too: `Vec::iter` reached through a Bevy wrapper is not Bevy
    // API, and the caller already knows that method from the std docs.
    if (crate && (DEP_CRATES.has(crate) || crate === "std")) return false;
  }

  // A method with a real docblock is worth full-text; one with none is only
  // reachable by name anyway, and there are ~30k of them.
  if (r.kind === "method") return !!(r.docs && r.docs.trim().length > 80);

  return true;
}

/** Dependency crates whose methods surface on Bevy types but are not Bevy API. */
const DEP_CRATES = new Set(["glam", "bevy_reflect", "bevy_math"]);

/**
 * Compare dotted versions numerically. Returns -1 / 0 / 1.
 *
 * Only the leading digits of each segment count, so pre-release builds compare
 * equal to their release: `0.20.0-rc.2` === `0.20.0`. Comparing the strings
 * directly would rank `0.19` above `0.9`.
 */
export function cmpVersion(a: string, b: string) {
  // Drop any pre-release / build suffix first: `0.20.0-rc.2` -> `0.20.0`.
  // Otherwise the `-rc` part splits into extra numeric-looking segments and
  // `0.20.0-rc.2` would compare as *greater than* `0.20.0`.
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

/**
 * How relevant a record is to the *pinned* Bevy version.
 *
 * This is the whole point of pinning: a 0.4 -> 0.5 guide is noise when the
 * project is on 0.19, while a guide whose target version equals the project's
 * version is exactly what the agent needs. Version strings can be suffixed
 * (-rc.1), which cmpVersion ignores.
 */
function versionWeight(r: Partial<BevyRecord>, bevyVersion: string | null | undefined) {
  if (!bevyVersion) return 1;
  const cur = bevyVersion;

  if (r.to_version) {
    const c = cmpVersion(r.to_version, cur);
    if (c === 0) return 2.5; // "upgrade to the version you are on"
    if (c < 0) return 0.3; // migration INTO an older version: historical noise
    return 0.8; // migration to a future version: useful, but not your API
  }
  if (r.from_version) {
    const c = cmpVersion(r.from_version, cur);
    if (c === 0) return 2.0; // "migrate away from the version you are on"
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
  constructor() {
    this.records = [];
    this.byId = new Map();
    this.symbols = new Map(); // normalised key -> [ids]
    this.text = null;
    this.meta = null;
    this.stats = { total: 0, by_source: {}, by_kind: {} };
  }

  /**
   * Add records, assigning a stable content-derived id when they lack one.
   *
   * Ids are version-qualified for version-specific sources (rustdoc) so the
   * same symbol in two Bevy versions does not collide. Without this, loading a
   * second version would overwrite the first version's record and make a
   * cross-version diff impossible.
   */
  addRecords(records: Iterable<BevyRecord>) {
    for (const r of records) {
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
      this.records.push(indexed);
      this.byId.set(indexed.id, indexed);
    }
  }

  /**
   * Build the exact-symbol table.
   *
   * Keys get progressively more qualified (`iter`, `Query::iter`,
   * `bevy::ecs::query::Query::iter`) so a bare name resolves but a qualified
   * query is precise. For leaf-only keys we keep the *best* candidates rather
   * than the first 40: `Sprite` must return `struct Sprite`, not
   * `Sprite::from_13` or some impl-noise method whose name merely contains it.
   */
  buildSymbolTable() {
    this.symbols = new Map();
    // Track whether a leaf key is ambiguous, so we can rank its candidates.
    const leafCandidates = new Map<string, Map<string, number>>();

    const add = (key: string, id: string, rank?: number) => {
      if (!key) return;
      const k = normKey(key);
      if (!k) return;
      let entry = this.symbols.get(k);
      if (!entry) this.symbols.set(k, (entry = []));
      if (entry.length < 60) entry.push(id);
      if (rank !== undefined) {
        let cand = leafCandidates.get(k);
        if (!cand) leafCandidates.set(k, (cand = new Map()));
        const prev = cand.get(id);
        if (prev === undefined || rank < prev) cand.set(id, rank);
      }
    };

    // Preference order for a bare-name match: the type itself beats a method.
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

      if (owner) add(`${owner}::${leaf}`, r.id, rank);
      if (r.module) {
        add(`${r.module}::${leaf}`, r.id, rank);
        if (owner) add(`${r.module}::${owner}::${leaf}`, r.id, rank);
      }
      add(leaf, r.id, rank);
    }

    // Reorder leaf keys so the most plausible definition comes first.
    for (const [k, cands] of leafCandidates) {
      const ids = this.symbols.get(k);
      if (!ids || ids.length <= 1) continue;
      const order = new Map<string, number>();
      let i = 0;
      for (const id of ids) if (!order.has(id)) order.set(id, i++);
      const sorted = [...cands.entries()].sort((a, b) => a[1] - b[1]);
      // Keep any ids that were not ranked (shouldn't happen) at the end.
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

  /**
   * Ingest rustdoc into this index.
   *
   * Split out from buildTextIndex so the registry can add records *before* the
   * full index is built. Used when a second version is added to a process that
   * already holds the active index: the shared text index is reused and only
   * the new version's items are appended, which is far cheaper than a rebuild.
   */
  async addRustdocAsync(docDir: string, version: string) {
    const records = ingestRustdoc(docDir, version).filter(
      (r) => recordWeight(r) > 0,
    );
    this.addRecords(records);
    // Same memory discipline as buildTextIndex: FlexSearch 0.8 `add()` is
    // synchronous, so add one payload at a time instead of materialising the
    // whole payload array (a full second copy of the corpus) in flight.
    if (this.text) {
      for (const r of records) {
        if (!this._isIndexed(r)) continue;
        if (r.id) this.text.add(this._flexPayload({ ...r, id: r.id }));
      }
    }
    return records.length;
  }

  /**
   * Run one FlexSearch query and map hits to records.
   *
   * `relaxed` drops stopwords and enables `suggest`, which switches FlexSearch
   * from AND to OR (progressive relaxation). The strict pass is tried first so
   * precise multi-word queries keep their precision.
   */
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
    // FlexSearch returns one group per indexed field ([{ field, result }]). A hit
    // in `name` means the query matched the symbol itself; a hit in `docs` means
    // it merely appeared in prose -- often someone else's code example. Rank the
    // former well above the latter. Without this, "spawn camera" surfaces a
    // struct whose docblock happens to contain a `spawn_camera` snippet.
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
          // Gentle positional decay (1, 0.998, 0.996, ...) so the field and name
          // boosts in hybridSearch decide the order, not FlexSearch's position.
          // A hard `base - i` went negative once the pool exceeded `base`.
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

  /**
   * Is this record worth a full-text posting list?
   *
   * Fields are excluded deliberately. They are ~10-15k records with very short,
   * highly repetitive text (`translation: Vec3`, `x: f32`), and indexing them
   * adds posting-list weight to common words without adding real intent signal
   * -- a concept query for "scale" gains nothing from `Transform::scale` and
   * loses ranking precision against real API. They remain fully reachable by
   * exact symbol lookup and by `bevy://owner/{v}/{Type}`, which is the access
   * path that actually answers "what fields does this type have".
   */
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
   * Build the full-text index.
   *
   * Field choice determines whether this fits in memory, and the measured
   * difference is stark. Over all ~265k Bevy records:
   *
   *   [name, full_path, signature, docs]  -> OOM at 2 GB, after ~10 min of GC
   *   [name, signature, docs]             -> 201 MB, 368 ms
   *   [name, docs]                        -> 181 MB, 384 ms
   *
   * The culprit is `full_path`: it is high-cardinality, so every module segment
   * becomes an enormous posting list for no ranking benefit. It stays on the
   * record as a filterable attribute -- exact lookup and resources both use it --
   * it simply is not an indexed term.
   *
   * Because the whole corpus now fits, nothing is excluded from search by
   * default: there is no curation trade-off, and completeness holds in every
   * layer.
   */
  async buildTextIndex({ onlySearchable = false }: { onlySearchable?: boolean } = {}) {
    this.text = new FlexSearch.Document<TextPayload>({
      document: {
        id: "id",
        index: ["name", "signature", "docs"],
        store: false,
      },
      // "forward" (FlexSearch's default) indexes every prefix of every word
      // ("system" -> s, sy, sys, ...) which is only useful for autocomplete and
      // scales super-linearly: measured ~10 min+ for 265k records. "strict"
      // indexes whole terms only - ~4x faster and ~2.5x smaller - and we do not
      // lose prefix behaviour because the exact symbol table (lookupSymbol)
      // already handles `Query`/`QueryData`-style lookups separately.
      tokenize: "strict",
    });
    const targets = onlySearchable
      ? this.records.filter((r) => isSearchable(r))
      : this.records;

    // FlexSearch 0.8's `add()` is synchronous; `addAsync()` merely wraps `add()`
    // in a resolved promise. The previous `Promise.all(targets.map(...))` built
    // two full-length arrays at once (265k payload objects + 265k promises),
    // i.e. a complete second copy of the corpus in flight on top of
    // `this.records` and the growing index - that was the OOM trigger. A plain
    // loop keeps peak memory to one payload at a time.
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
    const q = String(query || "").trim();
    if (!q) return [];
    const out: SearchHit[] = [];
    const seen = new Set<string>();

    const push = (ids: string[] | undefined, score: number, exactLeaf = false) => {
      for (const id of ids || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const rec = this.byId.get(id);
        if (!rec) continue;
        // A leaf-only key can point at unrelated names (Query -> QueryData), so
        // require a real name match before treating it as an exact hit.
        if (exactLeaf) {
          const leafName = baseName(rec.name).toLowerCase();
          const wanted = baseName(q).toLowerCase();
          const ownerName = baseName(rec.owner || "").toLowerCase();
          if (leafName !== wanted && !ownerName.includes(wanted)) continue;
        }
        out.push({ record: rec, score });
      }
    };

    // Try progressively shorter keys: most specific first.
    const candidates = [q];
    const stripped = q.replace(/^[a-z_][a-z0-9_]*::/i, "");
    if (stripped !== q) candidates.push(stripped);
    const noParens = q.replace(/\(\s*\)$/, "");
    if (noParens !== q && noParens !== stripped) candidates.push(noParens);

    candidates.forEach((c, i) => {
      const qualified = c.includes("::");
      push(this.symbols.get(normKey(c)), 1000 - i * 10, !qualified);
    });

    // If the user pasted a full generic signature, retry on the base name.
    const bn = baseName(q);
    if (bn !== q) push(this.symbols.get(normKey(bn)), 900);

    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Full-text search across the record set.
   *
   * `allowedIds` restricts results to a subset (used to isolate one version
   * when several are held in one index).
   */
  searchText(query: string, { limit = 20, allowedIds = null }: { limit?: number; allowedIds?: Set<string> | null } = {}): SearchHit[] {
    // FlexSearch's AND semantics is precise but brittle: "spawn camera" only
    // matches documents that literally contain both words, however irrelevant
    // they are. Run the same query again in OR/suggestion mode with stopwords
    // dropped and return those behind the strict hits, so a symbol whose NAME
    // matches one of the words still surfaces (and the field weighting in
    // _searchText lifts it above prose coincidences).
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

/**
 * Hybrid search: exact symbol matches first, then full text, de-duplicated.
 *
 * Ranking is (match quality x source weight). The weight stops `news` posts
 * from outranking real API documentation, while exact symbol hits always lead.
 */
/**
 * Enumerate records matching a resource query, without any full-text index.
 *
 * This is the path that makes every item reachable even when it is excluded
 * from the search index: a linear scan with cheap string predicates, costing
 * O(n) once (~10ms for 265k records) and needing no extra memory. That is the
 * whole reason Resources, not search, is the completeness guarantee.
 */
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

/**
 * Resolve one item by full path.
 *
 * Exact match first, then suffix match, so `primitives::Sphere` finds
 * `bevy::camera::primitives::Sphere`. Among candidates, a definition site beats
 * a prelude re-export, so `Sphere` resolves to the real type rather than to the
 * `bevy::prelude` alias for it.
 */
export function findByPath(index: BevyIndex, version: string | null, path: string): IndexedRecord | null {
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

  return matches
    .slice()
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.full_path.length - b.full_path.length ||
        a.full_path.localeCompare(b.full_path),
    )[0] ?? null;
}

/** Distinct defining crates in an index, for discovery. */
export function cratesIn(index: BevyIndex): string[] {
  return [...new Set(index.records.map(subCrateOf).filter((crate): crate is string => !!crate))].sort();
}

/**
 * Common request verbs ("how do I spawn/add/load X").
 *
 * In a multi-term query these are the *intent*, not the *subject*: "spawn
 * camera" is a question about `Camera`, not about `Spawn`. A record whose name
 * matches one of these therefore gets a weaker boost than one matching the
 * subject noun -- unless the verb is the whole query ("spawn"), where it is
 * exactly what the user asked for.
 */
const INTENT_VERBS = new Set([
  "spawn", "despawn", "add", "insert", "remove", "delete", "create", "make",
  "get", "set", "apply", "update", "build", "load", "open", "close", "play",
  "run", "start", "stop", "use", "attach", "register", "send", "emit", "read",
  "write", "enable", "disable", "toggle", "bind", "handle", "process",
]);

/**
 * How strongly a record's own NAME matches the query, as a multiplier.
 *
 * FlexSearch scores matches anywhere in the indexed text and cannot tell that
 * the subject of a request ("camera") matters more than its verb ("spawn").
 * A record literally named after a query word is almost always what was asked
 * for, and a type (struct/enum/trait/fn) answers "spawn X" better than a method
 * that merely mentions X, so both are boosted here on top of the field weights.
 */
function relevanceBoost(r: BevyRecord, terms: string[]) {
  if (!terms?.length) return 1;
  const leaf = baseName(r.name || "").toLowerCase();
  const leafWords = leaf.split(/[^a-z0-9]+/).filter(Boolean);
  const path = String(r.full_path || "").toLowerCase();
  let boost = 1;
  let matched = 0;
  for (const t of terms) {
    // In a multi-term query the intent verb is not the subject ("spawn camera"
    // asks about `Camera`, not about `Spawn`), so it contributes little.
    const intent = terms.length > 1 && INTENT_VERBS.has(t);
    if (leaf === t) {
      boost += intent ? 0.6 : 3;
      matched++;
    } else if (leafWords.includes(t)) {
      boost += intent ? 0.5 : 2.2;
      matched++;
    } else if (leaf.includes(t)) {
      boost += intent ? 0.3 : 1.4;
      matched++;
    } else if (path.includes(t)) {
      boost += 0.8;
    }
  }
  // A record matching several query terms in its name (`add_systems` for "add
  // systems") is a stronger hit than one matching a single term exactly.
  if (matched > 1) boost += (matched - 1) * 1.2;
  // A type answers "what/what is" better than a method that merely mentions it.
  if (["struct", "enum", "trait", "fn", "type", "primitive"].includes(r.kind)) {
    boost += 0.5;
  }
  return boost;
}

export function hybridSearch(
  index: BevyIndex,
  query: string,
  { limit = 8, filters = {}, scope = null }: { limit?: number; filters?: SearchFilters; scope?: Set<string> | null } = {},
): SearchHit[] {
  const cur = index.meta?.bevy_version;
  const weightOf = (r: BevyRecord) => recordWeight(r) * versionWeight(r, cur);
  const hasFilters = Object.values(filters || {}).some(Boolean);
  // A scope restricts to one version's records; web/version-independent prose is
  // shared, so it stays visible unless the caller filters it out.
  const scoped = (r: IndexedRecord) => !scope || r.source !== "rustdoc" || scope.has(r.id);

  // FlexSearch applies `limit` *before* we can filter or re-rank, so a narrow
  // pool starves: the name-weighted re-rank below can only lift records that
  // FlexSearch actually returned, and its own scoring buries a subject noun
  // ("camera") under every record whose name contains the verb ("add"). Ask for
  // a wide pool and narrow it ourselves.
  const pool = hasFilters ? Math.max(limit * 100, 3000) : Math.max(limit * 100, 2000);

  const terms = meaningfulTerms(query);
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

  // Keep fuzzy hits in a band strictly below the exact-symbol hits (scored
  // ~900-1000), so an exact match always leads no matter how strong a prose hit
  // looks. Normalising by the best raw score keeps the band meaningful without
  // hard-coding a ceiling.
  const rawFuzzy: { record: IndexedRecord; raw: number }[] = [];
  for (const hit of fuzzy) {
    if (seen.has(hit.record.id)) continue;
    seen.add(hit.record.id);
    rawFuzzy.push({
      record: hit.record,
      raw: hit.score * weightOf(hit.record) * relevanceBoost(hit.record, terms),
    });
  }
  const maxRaw = rawFuzzy.reduce((m, f) => Math.max(m, f.raw), 0) || 1;
  for (const f of rawFuzzy) {
    scored.push({ record: f.record, score: (f.raw / maxRaw) * 850 });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function buildFromSource(config: IndexConfig) {
  const idx = new BevyIndex();
  const t0 = Date.now();

  // Prose (book, migration guides, news) is version-independent: it comes from
  // one bevy-website checkout and is tagged per record anyway. So we parse it
  // once and share the records across every version index.
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

  // Drop sections that are never useful for coding help.
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

/**
 * Website markdown does not change per Bevy version, so parse it once per
 * process and reuse. This is most of the win when several versions are indexed.
 */
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
 * Find migration guidance between two versions.
 *
 * Migration guides are chunked by heading, and a big guide can be 75+ chunks
 * long. Collapsing each document to a single chunk throws away the very section
 * the caller asked about, so we keep the best N chunks per document instead.
 * The optional `topic` filter runs *before* ranking, so a topic match is never
 * discarded in favour of a higher-ranked chunk from the same document.
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

  // Group by document, keep the strongest few chunks of each.
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

/**
 * Split a Bevy version into its semver components.
 * Bevy's pre-1.0 versioning means the MINOR digit is the breaking-change axis:
 * 0.19 -> 0.20 breaks APIs, 0.19.0 -> 0.19.1 does not.
 */
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

/**
 * Classify the jump from version `from` to version `to`.
 *
 * Returns { level, breaksApi, direction, label }:
 *   level: 'none' | 'patch' | 'minor' | 'major' | 'downgrade'
 *   breaksApi: true only for a minor (or major) bump on a 0.x version, which is
 *     where Bevy performs its breaking changes.
 *
 * The user-facing distinction that matters: 0.19.0 -> 0.19.1 is a patch with a
 * handful of fixes and no API change, so an agent should NOT be told to rewrite
 * working code. 0.19 -> 0.20 is a sweeping overhaul and it should.
 */
function bumpBetween(from: string | null | undefined, to: string | null | undefined): VersionBump {
  if (!from || !to) {
    return { level: "unknown", breaksApi: true, direction: "unknown", label: "unknown" };
  }
  const a = versionKind(from);
  const b = versionKind(to);
  // Note cmpVersion returns < 0 when `from` is LOWER than `to`, so `from < to`
  // is an upgrade, not a downgrade.
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

  // Pre-1.0: the minor digit carries breaking changes.
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
