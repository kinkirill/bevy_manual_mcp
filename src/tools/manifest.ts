/** `bevy_check_manifest` tool — check which Bevy features are enabled. */
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isObject } from "../types.js";
import { loadFeatures, subcrateOf, findGatingFeatureForCheck, type FeaturesData } from "../analysis/features.js";
import type { ToolContext, VersionResolution } from "./types.js";

/** Parse a Cargo.toml and extract enabled Bevy features. */
function readEnabledFeatures(projectRoot: string): {
  explicit: string[];
  transitive?: string[];
} | null {
  const tomlPath = path.join(projectRoot, "Cargo.toml");
  if (!fs.existsSync(tomlPath)) return null;

  try {
    const raw = fs.readFileSync(tomlPath, "utf8");
    const parsed: unknown = parseToml(raw);
    if (!isObject(parsed)) return null;

    // Look for bevy dependency with features
    const deps = isObject(parsed.dependencies) ? parsed.dependencies : {};
    let explicitFeatures: string[] = [];

    // Check main dependencies
    const bevyEntry: unknown | undefined = deps.bevy;
    if (typeof bevyEntry === "object" && !Array.isArray(bevyEntry) && bevyEntry !== null) {
      const features = (bevyEntry as Record<string, unknown>).features;
      if (Array.isArray(features)) {
        explicitFeatures.push(...features.filter((f): f is string => typeof f === "string"));
      }
    }

    // Check workspace dependencies
    if (isObject(parsed.workspace)) {
      const wsDeps: Record<string, unknown> = isObject((parsed as any).workspace?.dependencies) ? (parsed as any).workspace.dependencies : {};
      for (const [_name, entry] of Object.entries(wsDeps)) {
        const e = entry as Record<string, unknown>;
        if (typeof e === "object" && !Array.isArray(e) && typeof e.features === "string") {
          // This would be unusual; handle gracefully
        } else if (isObject(entry) && Array.isArray(entry.features)) {
          const featArr = Array.isArray(entry) ? [] : (e as any)?.features;
          if (Array.isArray(featArr)) {
            explicitFeatures.push(...featArr.filter((f: unknown): f is string => typeof f === "string"));
          }
        }
      }
    }

    return { explicit: [...new Set(explicitFeatures)] };
  } catch {
    return null; // Can't parse — not an error, just no manifest available
  }
}

/** Compute the transitive closure of enabled features. */
function computeTransitive(
  explicit: string[],
  data: FeaturesData | null,
): string[] {
  if (!data?.closure) return [];

  const allEnabled = new Set(explicit);
  for (const feat of explicit) {
    const closure = data.closure![feat];
    if (Array.isArray(closure)) {
      for (const f of closure) {
        allEnabled.add(f);
      }
    }
  }

  return [...allEnabled].sort();
}

/** Get all feature names from the dataset. */
function allFeatureNames(data: FeaturesData | null): string[] {
  if (!data?.features) return [];
  return Object.keys(data.features).sort();
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_check_manifest",
    {
      title: "Check which Bevy features are enabled in a project",
      description:
        `Checks which Bevy features are enabled in the project's Cargo.toml and whether specific ` +
        `symbols or subcrates are available. Use this when writing code to verify that types, ` +
        `plugins, or systems you reference are actually available given the project's feature flags. ` +
        `Returns a clear yes/no for each check with the reason why it is available or not.`,
      inputSchema: {
        check: z
          .string()
          .optional()
          .describe(
            'Check a specific symbol, subcrate, or feature: "bevy_ui", "ui", "bevy::ui::Node", "DefaultPlugins". ' +
            'Omit to get the full manifest report.',
          ),
      },
    },
    async ({ check }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);

      const featuresData = loadFeatures(config, config.bevyVersion!);
      if (!featuresData) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `No feature graph available for Bevy ${config.bevyVersion}. Cannot perform feature checks.`,
          }],
        };
      }

      // Read the manifest (optional — not an error if missing)
      const projectRoot = config.projectRoot;
      const manifestResult = readEnabledFeatures(projectRoot);

      const explicit = manifestResult?.explicit ?? [];
      const transitive = computeTransitive(explicit, featuresData);
      const allKnown = allFeatureNames(featuresData);

      // Build disabled list (known features that are not enabled)
      const disabled = allKnown.filter((f) => !transitive.includes(f));

      if (!check) {
        // Full report
        let output = `## Bevy ${config.bevyVersion} — Feature Report\n\n`;

        if (!manifestResult) {
          output += "> No Cargo.toml found in project root. Showing known features for this version.\n\n";
        } else {
          output += `\`Cargo.toml\`: manifest parsed successfully.\n`;
          output += `**Explicit**: ${explicit.length > 0 ? explicit.join(", ") : "(none)"}\n`;
          output += `**Transitive**: ${transitive.length > 0 ? transitive.join(", ") : "(none)"}\n\n`;
        }

        // Table of all features
        output += "| Feature | Explicit | Transitive | Status |\n";
        output += "|---------|----------|------------|--------|\n";

        for (const feat of allKnown) {
          const isExplicit = explicit.includes(feat);
          const isInTransitive = transitive.includes(feat);
          const status = isExplicit ? "explicit" : isInTransitive ? "transitive" : "off";
          output += `| \`${feat}\` | ${isExplicit ? "✓" : "-"} | ${isInTransitive ? "✓" : "-"} | ${status} |\n`;
        }

        // Plugin gates info
        if (featuresData.plugin_gates?.length) {
          output += `\n### Plugin Gates\n\n`;
          for (const gate of featuresData.plugin_gates.slice(0, 20)) {
            const enabled = transitive.includes(gate.requires_feature);
            output += `- \`${gate.plugin}\` requires \`[${gate.requires_feature}]\`: ${enabled ? "✓ enabled" : "✗ disabled"}\n`;
          }
        }

        return {
          content: [{ type: "text", text: output.trimEnd() }],
          structuredContent: {
            bevy_version: config.bevyVersion,
            explicit,
            transitive,
            disabled,
            no_manifest: !manifestResult,
          },
        };
      }

      // Single check mode
      const verdict = checkFeature(check, featuresData, transitive);

      return {
        content: [{ type: "text", text: `## Check: \`${check}\`\n\n${verdict.text}` }],
        structuredContent: {
          query: check,
          available: verdict.available,
          reason: verdict.reason,
          gating_feature: verdict.gating_feature,
          bevy_version: config.bevyVersion,
        },
      };
    },
  );
}

/** Check a specific symbol or feature against the manifest. */
function checkFeature(
  query: string,
  featuresData: FeaturesData | null,
  transitive: string[],
): { available: boolean; reason?: string; gating_feature?: string; text: string } {

  // If it's a known feature name (with or without bevy_ prefix)
  const allKnown = allFeatureNames(featuresData);

  // Try direct match
  if (allKnown.includes(query)) {
    const enabled = transitive.includes(query);
    return {
      available: enabled,
      reason: enabled ? `"${query}" is enabled` : `"${query}" is not in the feature graph`,
      text: `${enabled ? "✓" : "✗"} \`${query}\` — ${enabled ? "available" : "not found in feature graph"}`,
    };
  }

  // Try with bevy_ prefix
  const prefixed = `bevy_${query}`;
  if (allKnown.includes(prefixed)) {
    const enabled = transitive.includes(prefixed);
    return {
      available: enabled,
      reason: enabled ? `"${prefixed}" is enabled` : `"${prefixed}" is not in the feature graph`,
      gating_feature: prefixed,
      text: `${enabled ? "✓" : "✗"} \`${query}\` (gated by \`[${prefixed}]\`) — ${enabled ? "available" : "disabled"}`,
    };
  }

  // Check if it's a module path like "bevy::ui::Node" or just "ui"
  const subcrate = subcrateOf(query);
  if (subcrate) {
    const gatingFeature = findGatingFeatureForCheck(subcrate, featuresData);
    const enabled = gatingFeature ? transitive.includes(gatingFeature) : false;

    return {
      available: enabled,
      reason: `subcrate "${subcrate}" gated by feature "[${gatingFeature}]"`,
      gating_feature: gatingFeature,
      text: `${enabled ? "✓" : "✗"} \`${query}\` — subcrate "${subcrate}" ${enabled ? "is available" : `requires \`[${gatingFeature}]\``}`,
    };
  }

  // Check if it's a plugin name like "DefaultPlugins" or just part of a path
  if (featuresData?.plugin_gates) {
    for (const gate of featuresData.plugin_gates) {
      if (gate.plugin.includes(query) || query.includes(gate.plugin)) {
        const enabled = transitive.includes(gate.requires_feature);
        return {
          available: enabled,
          reason: `"${gate.plugin}" gated by "[${gate.requires_feature}]"`,
          gating_feature: gate.requires_feature,
          text: `${enabled ? "✓" : "✗"} \`${query}\` — plugin "${gate.plugin}" ${enabled ? "is available" : `requires \`[${gate.requires_feature}]\``}`,
        };
      }
    }
  }

  // Last resort: check if it looks like a module path and try bevy_ prefix
  const fallbackFeature = query.startsWith("bevy::") || query.includes("::") ? null : `bevy_${query}`;
  if (fallbackFeature && allKnown.includes(fallbackFeature)) {
    const enabled = transitive.includes(fallbackFeature);
    return {
      available: enabled,
      reason: `${enabled ? "available" : "disabled"} via feature "[${fallbackFeature}]"`,
      gating_feature: fallbackFeature,
      text: `${enabled ? "✓" : "✗"} \`${query}\` — ${enabled ? "available" : `requires \`[${fallbackFeature}]\``}`,
    };
  }

  return {
    available: false,
    reason: `"${query}" is not a known feature or module in Bevy ${featuresData?.bevy_version ?? "unknown"}`,
    text: `✗ \`${query}\` — unknown query (not a recognized feature, subcrate, or plugin)`,
  };
}
