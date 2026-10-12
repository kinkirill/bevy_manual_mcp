/** `bevy_search` tool. */
import { z } from "zod";
import { hybridSearch } from "../store.js";
import { formatResults, toStructured } from "../format.js";
import { filterShape, filtersOf, type ToolContext } from "./types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_search",
    {
      title: "Search Bevy docs, API and examples",
      description:
        `Hybrid search over the Bevy API reference (rustdoc), the Bevy Book, migration guides, ` +
        `release notes and engine examples, all pinned to Bevy ${config.bevyVersion ?? "UNKNOWN"}. ` +
        `Use this for ANY question about how to do something in Bevy. Pass an exact symbol ` +
        `(e.g. "App::add_systems", "Query") to get its real signature; pass a concept ` +
        `(e.g. "system ordering", "2d camera") to get prose and examples. ` +
        `Call this before writing Bevy code - never rely on memory for signatures.`,
      inputSchema: {
        query: z
          .string()
          .describe('What to look for, e.g. "Query::iter", "add_systems ordering", "spawn ui text".'),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)."),
        version: z
          .string()
          .optional()
          .describe("Query a different indexed Bevy version (see bevy_indexed_versions)."),
        ...filterShape,
      },
    },
    async ({ query, limit = 8, version, ...rest }) => {
      const res = await resolveVersion(version);
      if (!res.known) return unavailableVersion(res.version);
      const results = hybridSearch(res.index, query, {
        limit,
        filters: filtersOf(rest),
      });
      const text =
        res.note + formatResults(res.index, results, query, { label: version || null });
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          ...toStructured(results, res.index),
          queried_version: version || config.bevyVersion,
          version_indexed: res.known,
        },
      };
    },
  );
}
