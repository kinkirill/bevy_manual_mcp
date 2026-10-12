/** bevy_ecosystem_search tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, type BevyIndex } from "../store.js";

export interface EcosystemToolContext {
  config: Record<string, unknown> & { bevyVersion?: string | null };
  pluginIndices?: Map<string, BevyIndex>;
}

export function register(server: McpServer, ctx: EcosystemToolContext): void {
  const { config } = ctx;

  server.registerTool(
    "bevy_ecosystem_search",
    {
      title: "Search across all indexed plugin corpora",
      description:
        "Fans out search across Bevy and all indexed plugin corpora. Every result is labelled with " +
        "its crate namespace so that egui::Button and bevy_ui::Button stay distinct. The optional " +
        "crate parameter restricts the search to one plugin.",
      inputSchema: {
        query: z.string().describe("Search query for API symbols types or concepts."),
        crate: z.string().optional().describe('Restrict to one crate e.g. bevy_egui. Omit to search all.'),
        limit: z.number().int().min(1).max(20).optional().describe("Max results per corpus default 8."),
      },
    },
    async ({ query, crate, limit = 8 }) => {
      let output = "## Ecosystem Search Results\n\n";

      const pluginIndices = ctx.pluginIndices || new Map();

      const results: Array<{ corpusId: string; hits: ReturnType<typeof hybridSearch> }> = [];

      if (crate) {
        for (const [id, index] of pluginIndices) {
          if (id.startsWith(crate + "@")) {
            const hits = hybridSearch(index, query, { limit });
            results.push({ corpusId: id, hits });
            break;
          }
        }
      } else {
        for (const [id, index] of pluginIndices) {
          const hits = hybridSearch(index, query, { limit });
          if (hits.length > 0) {
            results.push({ corpusId: id, hits });
          }
        }
      }

      for (const result of results) {
        output += `### Corpus: \`${result.corpusId}\`\n\n`;

        if (!result.hits || result.hits.length === 0) {
          output += "(no results in this corpus)\n";
          continue;
        }

        for (let i = 0; i < Math.min(result.hits!.length, limit); i++) {
          const hit = result.hits![i];
          if (!hit) continue;
          const r = hit.record;
          const name = r.name || "?";
          const kind = r.kind || "?";

          output += `- \`${name}\` — **[${kind}]**\n`;
          if (r.docs) {
            const snippet = r.docs.slice(0, 200).replace(/\n\s*\n/g, "\n").trim();
            output += `  ${snippet}...\n\n`;
          } else {
            output += "\n";
          }
        }
      }

      if (results.length === 0 || results.every((r) => r.hits!.length === 0)) {
        output += "\nWarning: No matching symbols found in any indexed corpus.\n";
        const available = [...pluginIndices.keys()];
        output += "Available corpora: " + (available.join(", ") || "(none)");
      }

      return {
        content: [{ type: "text", text: output.trimEnd() }],
        structuredContent: {
          query,
          corpora_searched: results.map((r) => r.corpusId),
          total_hits: results.reduce((sum, r) => sum + (r.hits?.length || 0), 0),
          bevy_version: config.bevyVersion ?? null,
        },
      };
    },
  );
}
