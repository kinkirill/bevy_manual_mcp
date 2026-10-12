/** `bevy_perf_advisor` tool — version-aware performance advice. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../types.js";
import type { ToolContext, VersionResolution } from "./types.js";

export interface PerfTopic {
  topic: string;
  symptoms?: string[];
  recommend?: string[];   // API symbols to use
  avoid?: string[];       // anti-patterns to warn about
  rationale?: string;
}

/** Load perf advice entries from vendored metadata. */
function loadPerfTopics(config: ResolvedConfig, version: string): PerfTopic[] {
  const perfPath = path.join(config.metaDir!, version, "perf.json");
  if (!fs.existsSync(perfPath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(perfPath, "utf8"));
    if (Array.isArray(raw)) {
      return raw.map((entry: unknown) => {
        const obj = entry as Record<string, unknown>;
        return {
          topic: typeof obj.topic === "string" ? obj.topic : "unknown",
          symptoms: Array.isArray(obj.symptoms) ? obj.symptoms.filter((s): s is string => typeof s === "string") : undefined,
          recommend: Array.isArray(obj.recommend) ? obj.recommend.filter((r): r is string => typeof r === "string") : undefined,
          avoid: Array.isArray(obj.avoid) ? obj.avoid.filter((a): a is string => typeof a === "string") : undefined,
          rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
        };
      });
    }
  } catch {
    // No perf data — not an error
  }

  return [];
}

/** Check if code contains anti-patterns for a given topic. */
function detectAntiPatterns(topic: string, code: string): Array<{ pattern: string; suggestion?: string }> {
  const findings: Array<{ pattern: string; suggestion?: string }> = [];

  switch (topic) {
    case "change-detection": {
      if (code.includes("is_changed")) {
        findings.push({
          pattern: "is_changed()",
          suggestion: "Use Changed<T> filter instead — the query planner pushes this down to archetype iteration",
        });
      }
      if (code.includes("is_added")) {
        findings.push({
          pattern: "is_added()",
          suggestion: "Use Added<T> filter instead — the query planner handles this efficiently",
        });
      }
      break;
    }
  }

  return findings;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_perf_advisor",
    {
      title: "Get version-aware Bevy performance advice",
      description:
        `Provides performance guidance for Bevy systems. With a topic argument, returns curated ` +
        `advice with the exact API symbols to use (version-correct). With code, detects anti-patterns ` +
        `like manual is_changed checks that prevent archetype optimisation.`,
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe(
            "Topic: change-detection, archetypes, scheduling, render, resources, events, commands.",
          ),
        code: z
          .string()
          .optional()
          .describe("Optional system code to analyse for anti-patterns."),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)."),
      },
    },
    async ({ topic, code, limit = 8 }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);

      let output = "## Bevy Performance Advisor\n\n";

      // Load vendored perf data (may not exist yet — use built-in defaults)
      const topics = loadPerfTopics(config, config.bevyVersion!);

      if (topic) {
        // Specific topic lookup
        const matched = topics.find((t) => t.topic === topic);

        if (matched) {
          output += "### Topic: " + topic + "\n\n";
          output += "**Rationale**: " + (matched.rationale ?? "") + "\n\n";

          if (matched.symptoms?.length) {
            output += "**Symptoms**:\n";
            for (const s of matched.symptoms) {
              output += "- " + s + "\n";
            }
            output += "\n";
          }

          if (matched.recommend?.length) {
            output += "**Use these symbols**:\n";
            for (const r of matched.recommend) {
              output += "- `" + r + "`\n";
            }
            output += "\n";
          }

          if (matched.avoid?.length) {
            output += "**Avoid these patterns**:\n";
            for (const a of matched.avoid) {
              output += "- " + a + "\n";
            }
            output += "\n";
          }
        } else {
          // Built-in defaults for common topics not yet in vendored data
          const builtinTopics = getBuiltInTopic(topic);
          if (builtinTopics) {
            output += "### Topic: " + topic + "\n\n";
            if (builtinTopics.rationale) output += "**Rationale**: " + builtinTopics.rationale + "\n\n";
            if (builtinTopics.symptoms?.length) {
              output += "**Symptoms**:\n";
              for (const s of builtinTopics.symptoms) output += "- " + s + "\n";
              output += "\n";
            }
            if (builtinTopics.recommend?.length) {
              output += "**Use these symbols**:\n";
              for (const r of builtinTopics.recommend) output += "- `" + r + "`\n";
              output += "\n";
            }
            if (builtinTopics.avoid?.length) {
              output += "**Avoid these patterns**:\n";
              for (const a of builtinTopics.avoid) output += "- " + a + "\n";
              output += "\n";
            }
          } else {
            output += "⚠️ Topic `" + topic + "` not found.\n\n";
            output += "**Available topics**: change-detection, archetypes, scheduling, render, resources, events, commands\n";
          }
        }

        // If code is also provided, run anti-pattern detection
        if (code) {
          const patterns = detectAntiPatterns(topic, code);
          if (patterns.length > 0) {
            output += "### Anti-Patterns Detected\n\n";
            for (const p of patterns) {
              output += "- **Found**: `" + p.pattern + "`\n";
              if (p.suggestion) output += "  - **Suggestion**: " + p.suggestion + "\n";
            }
          } else {
            output += "\nNo anti-patterns detected in the provided code.\n";
          }
        }

        return {
          content: [{ type: "text", text: output.trimEnd() }],
          structuredContent: {
            topic,
            bevy_version: config.bevyVersion,
            source: topics.length > 0 ? "vendored" : "builtin",
          },
        };
      }

      // No specific topic — list all available topics
      const allTopics = topics.map((t) => t.topic);
      if (allTopics.length === 0) {
        output += "**Available topics**: change-detection, archetypes, scheduling, render, resources, events, commands\n";
        output += "\nNo vendored perf data loaded yet. Run `scripts/harvest-meta.mts` to generate.\n";

        return {
          content: [{ type: "text", text: output.trimEnd() }],
          structuredContent: {
            bevy_version: config.bevyVersion,
            source: "builtin",
            available_topics: allTopics.length > 0 ? allTopics : undefined,
          },
        };
      }

      output += "**Available topics**:\n";
      for (const t of allTopics.slice(0, limit)) {
        const entry = topics.find((x) => x.topic === t);
        output += "- `" + t + "`" + (entry?.rationale ? " — " + entry.rationale.slice(0, 100) : "") + "\n";
      }

      return {
        content: [{ type: "text", text: output.trimEnd() }],
        structuredContent: {
          bevy_version: config.bevyVersion,
          topics: allTopics.slice(0, limit),
        },
      };
    },
  );
}

/** Built-in topic definitions for when vendored data is not yet loaded. */
function getBuiltInTopic(topic: string): PerfTopic | null {
  const topics: Record<string, PerfTopic> = {
    "change-detection": {
      topic: "change-detection",
      symptoms: ["iterating all entities every frame", "manual is_changed checks"],
      recommend: ["Changed<T>", "Added<T>", "Ref<T>", "Mut<T>", "With<T>"],
      avoid: ["is_changed()", "is_added()"],
      rationale: "Change ticks are stored per-archetype. Changed<T> and Added<T> filters let the query planner push these down to archetype iteration, avoiding per-entity tick comparisons.",
    },
    archetypes: {
      topic: "archetypes",
      symptoms: ["mid-iteration component additions causing archetype moves"],
      recommend: ["Commands", "despawn_many"],
      avoid: ["World::remove_component", "direct entity removal in systems"],
      rationale: "Component additions mid-iteration cause archetype moves. Use Commands for deferred changes.",
    },
    scheduling: {
      topic: "scheduling",
      symptoms: [".chain() overuse", "missing SystemSet ordering"],
      recommend: ["SystemSet", ".before()", ".after()", ".chain()"],
      avoid: ["manual order tracking"],
      rationale: "Use SystemSets for deterministic ordering. .chain() is useful but don't overuse it.",
    },
  };

  return topics[topic] ?? null;
}
