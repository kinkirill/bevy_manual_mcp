/** Feature graph loading, transitive closure, and path→feature resolution. */
import fs from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../types.js";

export interface FeaturesData {
  bevy_version: string;
  features: Record<string, string[]>;       // direct enables (non-closure)
  closure?: Record<string, string[]>;        // transitive closure of enables
  profiles?: Record<string, { description: string; enables: string[] }>;
  default_features?: string[];
  plugin_gates?: Array<{ plugin: string; requires_feature: string }>;
  panic_sites?: Record<string, Array<{ file: string; line: number }>>;
}

/** Load a version's feature graph from the vendored metadata. */
export function loadFeatures(config: ResolvedConfig, version: string): FeaturesData | null {
  const featuresPath = path.join(config.metaDir!, version, "features.json");
  if (!fs.existsSync(featuresPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    return {
      bevy_version: typeof raw.bevy_version === "string" ? raw.bevy_version : version,
      features: typeof raw.features === "object" && !Array.isArray(raw.features) ? raw.features : {},
      closure: typeof raw.closure === "object" && !Array.isArray(raw.closure) ? raw.closure : undefined,
      profiles: typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : undefined,
      default_features: Array.isArray(raw.default_features) ? raw.default_features : [],
      plugin_gates: Array.isArray(raw.plugin_gates) ? raw.plugin_gates : undefined,
      panic_sites: typeof raw.panic_sites === "object" && raw.panic_sites !== null && !Array.isArray(raw.panic_sites)
        ? raw.panic_sites as FeaturesData["panic_sites"]
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Resolve a Bevy module path (e.g. "bevy::ui") to the subcrate that owns it. */
export function subcrateOf(modulePath: string): string | null {
  // Bevy's facade re-exports subcrates under `bevy::<segment>`; the owning
  // subcrate is nearly always `bevy_<segment>` (ui → bevy_ui, ecs → bevy_ecs).
  // The feature graph is the final authority on whether that crate exists.
  const match = modulePath.match(/^bevy::([a-z0-9_]+)(?:::|$)/);
  return match ? `bevy_${match[1]}` : null;
}

/** Find the feature that gates a subcrate's plugin. */
export function findGatingFeatureForCheck(
  subcrate: string,
  featuresData: FeaturesData | null,
): string | undefined {
  const expectedFeature = subcrate.startsWith("bevy_") ? subcrate : `bevy_${subcrate}`;

  if (featuresData?.plugin_gates) {
    for (const gate of featuresData.plugin_gates) {
      if (gate.requires_feature === expectedFeature || gate.plugin.includes(subcrate)) {
        return gate.requires_feature;
      }
    }
  }

  // Fallback: assume feature name matches crate name pattern
  if (featuresData?.features && Object.prototype.hasOwnProperty.call(featuresData.features, expectedFeature)) {
    return expectedFeature;
  }

  return undefined;
}
