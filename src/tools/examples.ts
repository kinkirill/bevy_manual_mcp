/** `bevy_examples` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch } from "../store.js";
import { formatRecord } from "../format.js";
import { toStructured } from "../format.js";
import type { ToolContext } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { index, config } = ctx;
  const VERSION_NOTE = `Index built for Bevy ${config.bevyVersion ?? "UNKNOWN VERSION"}`;

  server.registerTool(
    "bevy_examples",
    {
      title: "Find Bevy code examples",
      description:
        "Finds runnable Bevy example code, either from the engine's own `examples/` directory or " +
        "from the Bevy Book's quick-start projects. Use this when you need a working pattern for a " +
        "concrete task (2D/3D rendering, UI, input, audio, assets, state, gizmos) rather than an API " +
        "signature. Returns the actual source code.",
      inputSchema: {
        task: z
          .string()
          .describe(
            'What you want to build, e.g. "2d camera", "button ui", "keyboard input", "play sound".',
          ),
        limit: z.number().int().min(1).max(15).optional(),
        category: z
          .string()
          .optional()
          .describe("Optional category filter, e.g. 'ui', '2d', 'input', 'audio'."),
      },
    },
    async ({ task, limit = 5, category }) => {
      const filters: { kind: string; category?: string } = { kind: "code_example" };
      if (category) filters.category = category;
      const results = hybridSearch(index, task, { limit, filters });
      if (!results.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No examples matched "${task}".\n` +
                `The index has ${index.stats.by_kind.code_example ?? 0} examples from: ` +
                `${config.examplesDir ?? "(no bevy source/examples dir)"} and ` +
                `${config.websiteDir ?? "(no website)"}/learning-code-examples.\n` +
                `Set BEVY_SRC_DIR to a bevy checkout for the engine's full examples. ` +
                `You can also list available categories by calling this with a broad task like "2d".`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `## ${VERSION_NOTE} - examples for "${task}"\n\n` +
              results.map(({ record }) => formatRecord(record, { docsChars: 4000 })).join("\n\n---\n\n"),
          },
        ],
        structuredContent: toStructured(results, index),
      };
    },
  );
}
