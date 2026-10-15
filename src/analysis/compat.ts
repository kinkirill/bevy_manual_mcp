/** Ecosystem compatibility helpers — requirement satisfaction + vendored snapshot. */
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

/** Parse a caret/wildcard/exact requirement into an inclusive-min, exclusive-max range. */
export function parseCaretRange(range: string): { min: string; max: string } | null {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    const major = parseInt(parts[0] || "0", 10);
    const minor = parseInt(parts[1] || "0", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    // Caret on 0.x is tilde-like (`^0.20.0` < 0.21.0); on 1.x+ it spans the major line.
    return major === 0
      ? { min: ver, max: `0.${minor + 1}.0` }
      : { min: ver, max: `${major + 1}.0.0` };
  }
  if (trimmed.startsWith("~")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    const minor = parseInt(parts[1] || "0", 10);
    // Tilde allows patch updates only.
    return Number.isFinite(minor) ? { min: ver, max: `${parts[0] || "0"}.${minor + 1}.0` } : { min: ver, max: ver };
  }
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return { min: trimmed, max: trimmed };
  const wildcard = trimmed.replace(/\*/g, "").split(".");
  if (wildcard.length === 2) {
    const p0 = wildcard[0] ?? "0";
    return { min: `${p0}.${wildcard[1] || "0"}.0`, max: `${parseInt(p0, 10) + 1}.0.0` };
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

/** Does `version` satisfy the raw requirement `req`? Exact requirements are inclusive. */
export function satisfiesRequirement(req: string, version: string): boolean {
  const range = parseCaretRange(req);
  if (!range) return false;
  if (range.min === range.max) return compareVersions(version, range.min) === 0;
  return satisfiesRange(version, range.min, range.max);
}

/** Absolute path to the vendored compatibility snapshot. */
export function vendoredCompatPath(override?: string | null): string {
  return override || path.join(PACKAGE_ROOT, "vendor", "ecosystem", "compat.json");
}

/** Load the whole vendored snapshot, keyed by plugin crate name. */
export function loadVendoredCompatAll(override?: string | null): Record<string, CompatibilityEntry[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(vendoredCompatPath(override), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as Record<string, CompatibilityEntry[]>;
  } catch {
    return {};
  }
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
