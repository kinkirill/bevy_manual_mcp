/** `bevy_migration` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findMigrations } from "../store.js";
import { formatRecord, toStructured } from "../format.js";
import type { ToolContext } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, index } = ctx;

  server.registerTool(
    "bevy_migration",
    {
      title: "Bevy version migration notes",
      description:
        "Returns breaking changes between two Bevy versions. Use this whenever upgrading a project, " +
        "when the user's code fails to compile, or when you are unsure whether an API changed between " +
        "releases. Includes consolidated migration guides and per-PR breaking-change notes.",
      inputSchema: {
        from_version: z
          .string()
          .optional()
          .describe("Version being upgraded from, e.g. '0.19'. Omit with to_version for a release summary."),
        to_version: z
          .string()
          .optional()
          .describe("Version being upgraded to, e.g. '0.20'."),
        topic: z
          .string()
          .optional()
          .describe('Optional filter, e.g. "scheduler", "render", "ui", "asset".'),
      },
    },
    async ({ from_version, to_version, topic }) => {
      const to = to_version || config.bevyVersion;
      if (!to) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Specify `to_version`, or set BEVY_VERSION so the server knows your target version.",
            },
          ],
        };
      }

      const all = findMigrations(index, from_version ?? null, to, { topic });
      const results = all;

      if (!results.length) {
        return {
          content: [
            {
              type: "text",
              text:
                `No migration notes found${from_version ? ` for ${from_version} → ${to}` : ` for ${to}`}` +
                `${topic ? ` matching "${topic}"` : ""}.\n` +
                `Note: Bevy's 0.19→0.20 guide is still marked hidden upstream and contains a ` +
                `"1. TODO" placeholder, so it is incomplete. For authoritative breaking changes, ` +
                `diff the two versions' rustdoc, or check the release notes for ${to}.`,
            },
          ],
        };
      }

      const text = results
        .slice(0, 12)
        .map(({ record }) => formatRecord(record, { docsChars: 1800 }))
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text",
            text:
              `## Migration notes${from_version ? ` ${from_version} → ${to}` : ` for ${to}`}` +
              `${topic ? ` matching "${topic}"` : ""}\n\n${text}`,
          },
        ],
        structuredContent: toStructured(results.slice(0, 30), index),
      };
    },
  );
}
