/** Ecosystem compatibility helpers — requirement evaluation + vendored snapshot. */
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../config.js";

export interface CompatibilityEntry {
  /** Plugin crate name, e.g. "bevy_egui". */
  plugin: string;
  /** Plugin version. */
  plugin_version: string;
  /** Required Bevy version requirement, e.g. "^0.20.0". */
  requires_bevy: string;
}

/** Provenance for a vendored compatibility snapshot. */
export interface CompatSnapshotMeta {
  harvested_at: string | number | null;
  source: string;
  version_count: number;
  plugin_count: number;
  complete: boolean;
}

export interface CompatSnapshot {
  plugins: Record<string, CompatibilityEntry[]>;
  meta: CompatSnapshotMeta;
}

export type RequirementVerdict = "satisfied" | "unsatisfied" | "unknown";

interface ParsedVersion { major: number; minor: number; patch: number }

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
}

function compareTriples(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function triple(major: number, minor = 0, patch = 0): ParsedVersion {
  return { major, minor, patch };
}

/**
 * Parse one Cargo comparator into a predicate. Returns null for expressions the
 * deliberately limited parser does not support (`||`, `git+`, branches…), which
 * callers must treat as *unknown*, never as a negative verdict.
 */
function parseComparator(token: string): ((version: ParsedVersion) => boolean) | null {
  const text = token.trim().replace(/\s+/g, "");
  if (!text) return null;

  // Comparison operators.
  const comparison = text.match(/^(>=|<=|>|<|=)(.+)$/);
  if (comparison) {
    const version = parseVersion(comparison[2]!);
    if (!version) return null;
    switch (comparison[1]) {
      case ">=": return (v) => compareTriples(v, version) >= 0;
      case ">": return (v) => compareTriples(v, version) > 0;
      case "<=": return (v) => compareTriples(v, version) <= 0;
      case "<": return (v) => compareTriples(v, version) < 0;
      default: return (v) => compareTriples(v, version) === 0;
    }
  }

  // Wildcards: any, major.*, major.minor.*
  if (text === "*" || text === "x" || text === "X") return () => true;
  const wildcard = text.match(/^(\d+)(?:\.(\d+))?\.[xX*]$/);
  if (wildcard) {
    const major = Number(wildcard[1]);
    if (wildcard[2] === undefined) {
      return (v) => v.major === major;
    }
    const minor = Number(wildcard[2]);
    return (v) => v.major === major && v.minor === minor;
  }

  // Caret and tilde.
  const caret = text.startsWith("^");
  const tilde = text.startsWith("~");
  const bare = caret || tilde ? text.slice(1) : text;
  const parts = bare.split(".");
  if (parts.length > 3 || parts.some((part) => part !== "" && !/^\d+$/.test(part))) return null;
  const numbers = parts.map((part) => Number(part || 0));
  const min = triple(numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0);
  const specified = parts.filter((part) => part !== "").length;

  if (caret) {
    // ^1.2.3 = <2.0.0; ^0.2.3 = <0.3.0; ^0.0.3 = <0.0.4; ^0.0 = <0.1.0; ^0 = <1.0.0
    let max: ParsedVersion;
    if (min.major > 0) max = triple(min.major + 1);
    else if (min.minor > 0 || specified <= 1) max = triple(0, min.minor + 1);
    else if (specified <= 2) max = triple(0, 1);
    else max = triple(0, 0, min.patch + 1);
    return (v) => compareTriples(v, min) >= 0 && compareTriples(v, max) < 0;
  }
  if (tilde) {
    // ~1.2.3 = <1.3.0; ~1.2 = <1.3.0; ~1 = <2.0.0
    const max = specified <= 1 ? triple(min.major + 1) : triple(min.major, min.minor + 1);
    return (v) => compareTriples(v, min) >= 0 && compareTriples(v, max) < 0;
  }
  // A bare version is Cargo's caret requirement.
  let max: ParsedVersion;
  if (min.major > 0) max = triple(min.major + 1);
  else if (min.minor > 0) max = triple(0, min.minor + 1);
  else max = triple(0, 0, min.patch + 1);
  return (v) => compareTriples(v, min) >= 0 && compareTriples(v, max) < 0;
}

function parseRequirement(requirement: string): ((version: ParsedVersion) => boolean)[] | null {
  const tokens = requirement.split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const predicates: ((version: ParsedVersion) => boolean)[] = [];
  for (const token of tokens) {
    // Spaces inside a comparator (`>= 1.2`) are valid Cargo; strip before parsing.
    const predicate = parseComparator(token.replace(/\s+/g, ""));
    if (!predicate) return null;
    predicates.push(predicate);
  }
  return predicates;
}

/** Tri-state Cargo requirement evaluation. Unsupported syntax is `unknown`. */
export function evaluateRequirement(requirement: string, version: string): RequirementVerdict {
  const parsed = parseVersion(version);
  if (!parsed) return "unknown";
  const predicates = parseRequirement(requirement);
  if (!predicates) return "unknown";
  for (const predicate of predicates) if (!predicate(parsed)) return "unsatisfied";
  return "satisfied";
}

/** Legacy caret/wildcard/exact range helper retained for range assertions. */
export function parseCaretRange(range: string): { min: string; max: string } | null {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    const major = parseInt(parts[0] || "0", 10);
    const minor = parseInt(parts[1] || "0", 10);
    const patch = parseInt(parts[2] || "0", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    if (major !== 0) return { min: ver, max: `${major + 1}.0.0` };
    if (minor !== 0) return { min: ver, max: `0.${minor + 1}.0` };
    return { min: ver, max: `0.0.${patch + 1}` };
  }
  if (trimmed.startsWith("~")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    const major = parseInt(parts[0] || "0", 10);
    const minor = parseInt(parts[1] || "0", 10);
    // Tilde allows patch updates only.
    return Number.isFinite(minor) ? { min: ver, max: `${major}.${minor + 1}.0` } : { min: ver, max: ver };
  }
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return { min: trimmed, max: trimmed };
  const wildcard = trimmed.split(".");
  if (wildcard.length === 3 && /^[xX*]$/.test(wildcard[2]!)) {
    const major = parseInt(wildcard[0] || "0", 10);
    const minor = parseInt(wildcard[1] || "0", 10);
    return { min: `${major}.${minor}.0`, max: `${major}.${minor + 1}.0` };
  }
  if (wildcard.length === 2 && /^[xX*]$/.test(wildcard[1]!)) {
    const major = parseInt(wildcard[0] || "0", 10);
    return { min: `${major}.0.0`, max: `${major + 1}.0.0` };
  }
  return null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Check if a version falls within an inclusive-min, exclusive-max range. */
export function satisfiesRange(version: string, min: string, max: string): boolean {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0;
}

/** Does `version` satisfy the raw requirement `req`? Unsupported syntax is `false`. */
export function satisfiesRequirement(req: string, version: string): boolean {
  return evaluateRequirement(req, version) === "satisfied";
}

/** Absolute path to the vendored compatibility snapshot. */
export function vendoredCompatPath(override?: string | null): string {
  return override || path.join(PACKAGE_ROOT, "vendor", "ecosystem", "compat.json");
}

function isEntry(value: unknown): value is CompatibilityEntry {
  return typeof value === "object" && value !== null &&
    typeof (value as CompatibilityEntry).plugin === "string" &&
    typeof (value as CompatibilityEntry).plugin_version === "string" &&
    typeof (value as CompatibilityEntry).requires_bevy === "string";
}

/** Load the whole vendored snapshot with provenance, keyed by plugin crate name. */
export function loadVendoredCompatSnapshot(override?: string | null): CompatSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(vendoredCompatPath(override), "utf8")) as unknown;
  } catch {
    return { plugins: {}, meta: { harvested_at: null, source: "missing", version_count: 0, plugin_count: 0, complete: false } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { plugins: {}, meta: { harvested_at: null, source: "invalid", version_count: 0, plugin_count: 0, complete: false } };
  }
  const record = raw as Record<string, unknown>;
  // Current format wraps the per-plugin map with a `meta` table; the legacy bare
  // map is still accepted so an older checkout keeps working.
  const wrapped = typeof record.meta === "object" && record.meta !== null && typeof record.plugins === "object" && record.plugins !== null;
  const pluginsRaw = (wrapped ? record.plugins : record) as Record<string, unknown>;
  const plugins: Record<string, CompatibilityEntry[]> = {};
  for (const [crate, entries] of Object.entries(pluginsRaw)) {
    if (!Array.isArray(entries)) continue;
    plugins[crate] = entries.filter(isEntry);
  }
  const versionCount = Object.values(plugins).reduce((sum, entries) => sum + entries.length, 0);
  const metaRaw = wrapped ? (record.meta as Record<string, unknown>) : {};
  return {
    plugins,
    meta: {
      harvested_at: typeof metaRaw.harvested_at === "string" || typeof metaRaw.harvested_at === "number" ? metaRaw.harvested_at : null,
      source: typeof metaRaw.source === "string" ? metaRaw.source : "vendored",
      version_count: typeof metaRaw.version_count === "number" ? metaRaw.version_count : versionCount,
      plugin_count: typeof metaRaw.plugin_count === "number" ? metaRaw.plugin_count : Object.keys(plugins).length,
      complete: metaRaw.complete !== false,
    },
  };
}

/** Load the whole vendored snapshot, keyed by plugin crate name. */
export function loadVendoredCompatAll(override?: string | null): Record<string, CompatibilityEntry[]> {
  return loadVendoredCompatSnapshot(override).plugins;
}

/** Load one plugin's vendored compatibility entries. */
export function loadVendoredCompat(crateName: string): CompatibilityEntry[] {
  return loadVendoredCompatAll()[crateName] ?? [];
}

/** Build a compatibility matrix keyed by required Bevy version. */
export function buildCompatMatrix(entries: CompatibilityEntry[]): Map<string, string[]> {
  const matrix = new Map<string, string[]>();
  for (const entry of entries) {
    let plugins = matrix.get(entry.requires_bevy);
    if (!plugins) matrix.set(entry.requires_bevy, (plugins = []));
    const key = `${entry.plugin}@${entry.plugin_version}`;
    if (!plugins.includes(key)) plugins.push(key);
  }
  return matrix;
}
