/** `bevy_check_version` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bumpBetween } from "../store.js";
import type { ToolContext } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, checkVersions } = ctx;

  server.registerTool(
    "bevy_check_version",
    {
      title: "Check whether the indexed Bevy version is current",
      description:
        "Checks crates.io for the newest published Bevy version and compares it to the version " +
        "this server is indexed for. IMPORTANT: it distinguishes a PATCH release (0.19.0 -> 0.19.1, " +
        "bug fixes only, no API changes, nothing to migrate) from a MINOR release (0.19 -> 0.20, " +
        "which is where Bevy makes sweeping breaking API changes). Pre-releases like 0.20.0-rc.2 are " +
        "reported separately and never recommended as a target. Call this before suggesting an " +
        "upgrade, so a patch bump does not trigger a pointless rewrite.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the local cache and re-query crates.io (default false)."),
      },
    },
    async ({ refresh = false }) => {
      const info = await checkVersions({ refresh });

      if (!info.ok && !info.stale) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Could not reach crates.io: ${info.error}\n` +
                `Still indexed for Bevy ${config.bevyVersion ?? "UNKNOWN"}. ` +
                `Set BEVY_MCP_OFFLINE=1 to suppress this check.`,
            },
          ],
        };
      }

      const data = info.ok ? info : info.stale;
      if (!data) return { isError: true, content: [{ type: "text", text: "No version information is available." }] };
      const mine = config.bevyVersion;
      const newest = data.newest_stable;
      const bump = bumpBetween(mine, newest);

      const lines = [
        `# Bevy version status`,
        ``,
        `- **This server is indexed for:** ${mine ?? "UNKNOWN"}`,
        `- **Newest stable on crates.io:** ${newest}`,
        `- **Newest pre-release:** ${data.preview ?? "none"}`,
        ``,
        `## Assessment`,
        ``,
        bump.label,
      ];

      if (bump.level === "none") {
        lines.push(
          ``,
          `Your index is current. Nothing to do.`,
        );
      } else if (!bump.breaksApi) {
        lines.push(
          ``,
          `**No API changes.** This is a patch release, so your existing Bevy code ` +
            `remains valid and there is no migration work. It may be worth updating ` +
            `Cargo.lock to pick up bug fixes.`,
          ``,
          `To index it anyway: \`npm run fetch-docs -- ${newest}\` (or \`cargo doc\` in your ` +
            `project) and set BEVY_VERSION=${newest}.`,
        );
      } else {
        lines.push(
          ``,
          `**Breaking API changes expected.** Do NOT silently rewrite the user's code. ` +
            `Call \`bevy_migration\` with from_version=${mine}, to_version=${newest} for the ` +
            `concrete list of changes before proposing any edit.`,
        );
      }

      if (data.preview && data.preview !== newest) {
        lines.push(
          ``,
          `_Note: ${data.preview} is a pre-release. It is not recommended for production; ` +
            `it is mentioned only so you know what is coming._`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          indexed_version: mine,
          newest_stable: newest,
          preview: data.preview,
          bump_level: bump.level,
          breaks_api: bump.breaksApi,
          direction: bump.direction,
          action_needed: bump.level !== "none",
          recent_versions: data.recent,
          source: "crates.io",
        },
      };
    },
  );
}
