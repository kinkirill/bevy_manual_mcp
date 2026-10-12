/** Ecosystem compatibility helpers — crates.io dep resolution + caching. */
import fs from "node:fs";
import path from "node:path";

export interface CrateVersion {
  crate: string;
  version: string;
}

export interface CompatibilityEntry {
  /** Plugin crate name, e.g. "bevy_egui". */
  plugin: string;
  /** Plugin version. */
  plugin_version: string;
  /** Required bevy version (exact). */
  requires_bevy: string;
}

/** Parse a caret range like "^0.20.0" into start and end versions. */
export function parseCaretRange(range: string): { min: string; max: string } | null {
  const trimmed = range.trim();

  // Handle ^X.Y.Z → >=X.Y.Z, <(X+1).Y.Z (or similar for minor bumps)
  if (trimmed.startsWith("^")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    try {
      const major = parseInt(parts[0] || "0", 10);
      const minor = parseInt(parts[1] || "0", 10);
      // For Bevy 0.x: ^0.20.0 → >=0.20.0, <0.21.0 (minor bump is breaking)
      if (major === 0) {
        return { min: ver, max: `0.${minor + 1}.0` };
      }
      // For 1.x+: ^1.2.3 → >=1.2.3, <1.3.0
      return { min: ver, max: `${major}.${minor + 1}.0` };
    } catch {
      return null;
    }
  }

  // Handle ~X.Y.Z (patch ranges) — less common for Bevy deps
  if (trimmed.startsWith("~")) {
    const ver = trimmed.slice(1);
    return { min: ver, max: ver };
  }

  // Exact version match
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return { min: trimmed, max: trimmed };
  }

  // Wildcard like "0.20.*" — resolve to range
  const wildcard = trimmed.replace(/\*/g, "");
  const parts2 = wildcard.split(".");
  if (parts2.length === 2) {
    try {
      const p0 = parts2[0] ?? "0";
      return { min: `${p0}.${parts2[1] || "0"}.0`, max: `${parseInt(p0, 10) + 1}.0.0` };
    } catch {
      return null;
    }
  }

  return null;
}

/** Check if a version satisfies a caret range. */
export function satisfiesRange(version: string, min: string, max: string): boolean {
  const cmp = (a: string, b: string) => {
    const pa = parseVer(a);
    const pb = parseVer(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  return cmp(version, min) >= 0 && cmp(version, max) < 0;
}

function parseVer(v: string): number[] {
  return v.split(".").map((s) => parseInt(s, 10) || 0);
}

/** Fetch compatibility data from crates.io for a plugin crate. */
export async function fetchCompat(crateName: string, offline: boolean): Promise<CompatibilityEntry[]> {
  const url = `https://crates.io/api/v1/crates/${crateName}`;
  
  if (!offline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = JSON.parse(await res.text()) as { versions: Array<{ version: string; dependencies: Array<{ crate_id: string; version_req: string }> }>; total: number };
        // Filter to bevy-related deps and collect all versions
        const entries: CompatibilityEntry[] = [];
        for (const ver of data.versions) {
          if (!ver.dependencies) continue;
          for (const dep of ver.dependencies) {
            if (dep.crate_id !== "bevy" && !dep.crate_id.startsWith("bevy_")) continue;
            // Parse version_req to find the exact bevy version
            const parsed = parseCaretRange(dep.version_req);
            if (!parsed) continue;
            entries.push({ plugin: crateName, plugin_version: ver.version, requires_bevy: parsed.min });
          }
        }
        return entries;
      }
    } catch {
      // Network error — will fall back to vendored data
    }
  }

  // Offline or network failure — try vendored snapshot
  return loadVendoredCompat(crateName);
}

/** Load a vendored compat snapshot. */
export function loadVendoredCompat(crateName: string): CompatibilityEntry[] {
  const indexPath = path.join(__dirname, "..", "..", "vendor", "ecosystem", "compat.json");
  if (!fs.existsSync(indexPath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, CompatibilityEntry[]>;
    return data[crateName] || [];
  } catch {
    return [];
  }
}

/** Build a compatibility matrix for all known plugins. */
export function buildCompatMatrix(entries: CompatibilityEntry[]): Map<string, string[]> {
  const matrix = new Map<string, string[]>();
  for (const entry of entries) {
    let plugins = matrix.get(entry.requires_bevy);
    if (!plugins) {
      plugins = [];
      matrix.set(entry.requires_bevy, plugins);
    }
    const key = `${entry.plugin}@${entry.plugin_version}`;
    if (!plugins.includes(key)) plugins.push(key);
  }
  return matrix;
}
