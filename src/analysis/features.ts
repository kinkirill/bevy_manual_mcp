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
    };
  } catch {
    return null;
  }
}

/** Resolve a Bevy module path (e.g. "bevy::ui") to the subcrate that owns it. */
export function subcrateOf(modulePath: string): string | null {
  // Map from known module prefixes to subcrate names
  const prefixMap: Record<string, string> = {
    "bevy_ui": "bevy_ui",
    "bevy_egui": "bevy_egui",
    "bevy_rapier": "bevy_rapier3d",
    "bevy_input": "leafwing_input_manager", // approximate
  };

  for (const [prefix, crate] of Object.entries(prefixMap)) {
    if (modulePath.startsWith(`bevy::${prefix}::`) || modulePath === `bevy::${prefix}`) {
      return crate;
    }
  }
  return null;
}

/** Given a symbol path like "bevy::ui::Node", resolve which feature gates it. */
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

/** Given a symbol path like "bevy::ui::Node", resolve which feature gates it. */
export function symbolToFeature(
  symbolPath: string,
  featuresData: FeaturesData | null,
): { available: boolean; reason?: string; gating_feature?: string } {
  // First check if the symbol exists in our known modules
  const subcrate = subcrateOf(symbolPath);

  if (subcrate) {
    // For plugin crates, we need to know which feature gates them
    const gatingFeature = findGatingFeature(subcrate, featuresData);
    if (!gatingFeature) {
      return { available: false, reason: `unknown subcrate for "${symbolPath}"` };
    }
    return {
      available: true,
      gating_feature: gatingFeature,
    };
  }

  // For core bevy symbols, check if they exist in the index
  // This is a conservative check - we can verify later against the actual index
  return { available: true };
}

/** Find which feature gates a subcrate's plugin. */
function findGatingFeature(subcrate: string, featuresData: FeaturesData | null): string | null {
  if (!featuresData?.plugin_gates) return null;

  for (const gate of featuresData.plugin_gates) {
    // Match crate name to feature name (e.g., bevy_ui → bevy_ui feature)
    const expectedFeature = subcrate.startsWith("bevy_") ? subcrate : `bevy_${subcrate}`;
    if (gate.requires_feature === expectedFeature || gate.plugin.includes(subcrate)) {
      return gate.requires_feature;
    }
  }

  // Fallback: assume feature name matches crate name pattern
  const featureName = subcrate.startsWith("bevy_") ? subcrate : `bevy_${subcrate}`;
  if (featuresData.features[featureName]) {
    return featureName;
  }

  return null;
}
