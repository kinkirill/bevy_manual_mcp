/** bevy_ecosystem_compat tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveConfig } from "../config.js";
import { loadVendoredCompatAll, satisfiesRequirement } from "../analysis/compat.js";

export interface CompatToolContext {
  config: ReturnType<typeof resolveConfig>;
}

export function register(server: McpServer, ctx: CompatToolContext): void {
  const { config } = ctx;

  server.registerTool(
    "bevy_ecosystem_compat",
    {
      title: "Check plugin compatibility with the pinned Bevy version",
      description:
        "Answers both directions of the compatibility question: which plugin version goes with my " +
        "Bevy, and what does this plugin need. Uses vendored compat data (vendor/ecosystem/compat.json) " +
        "with crates.io as a fallback. Never answers from a neighbouring Bevy version index.",
      inputSchema: {
        crate: z.string().optional().describe("Plugin crate name e.g. bevy_egui. Omit to check all."),
      },
    },
    async ({ crate }) => {
      const bevyVersion = config.bevyVersion;
      let output = "## Plugin Compatibility\n\n";

      const vendored = loadVendoredCompatAll();

      if (crate) {
        const entries = vendored[crate];

        if (!entries || !entries.length) {
          output += `Warning: No compat data for \`${crate}\`.\n\n`;
          output += "Available plugins: " + Object.keys(vendored).join(", ") + "\n";
          return {
            isError: true,
            content: [{ type: "text", text: output.trimEnd() }],
          };
        }

        let compatible = false;
        if (bevyVersion) {
          for (const entry of entries) {
            if (satisfiesRequirement(entry.requires_bevy, bevyVersion)) {
              compatible = true;
              break;
            }
          }
        } else {
          compatible = true;
        }

        if (compatible) {
          output += `[OK] \`${crate}\` is compatible with Bevy ${bevyVersion}.\n\n`;
        } else {
          output += `[WARN] \`${crate}\` may not be compatible.\n\n`;
          const versions = [...new Set(entries.map((e) => e.plugin_version))];
          output += "Available versions: " + versions.join(", ") + "\n";

          if (entries.length > 0) {
            const lastEntry = entries[entries.length - 1];
            const latest = lastEntry?.requires_bevy;
            if (bevyVersion && bevyVersion !== latest) {
              output += `This plugin requires Bevy ${latest} but you are on ${bevyVersion}.\n`;
            }
          }
        }

        return {
          content: [{ type: "text", text: output.trimEnd() }],
          structuredContent: {
            crate,
            bevy_version: bevyVersion,
            compatible,
          },
        };
      }

      // No specific crate - show compatibility matrix.
      if (bevyVersion) {
        output += `For Bevy ${bevyVersion}:\n\n`;

        for (const [pluginName, entries] of Object.entries(vendored)) {
          const compatibleVersions: string[] = [];
          for (const entry of entries) {
            if (satisfiesRequirement(entry.requires_bevy, bevyVersion)) {
              compatibleVersions.push(entry.plugin_version);
            }
          }

          const marker = compatibleVersions.length > 0 ? "[OK]" : "[WARN]";
          output += `${marker} \`${pluginName}\`: ` + (compatibleVersions.join(", ") || "(no matching version)") + "\n";
        }
      } else {
        output += "No Bevy version pinned.\n\n";
        for (const [pluginName, entries] of Object.entries(vendored)) {
          const vList: string[] = entries.map((e) => e.plugin_version);
          const uniqueV = [...new Set(vList)];
          output += `- \`${pluginName}\`: ${uniqueV.join(", ")}\n`;
        }
      }

      return {
        content: [{ type: "text", text: output.trimEnd() }],
        structuredContent: {
          bevy_version: bevyVersion,
          crates_available: Object.keys(vendored),
        },
      };
    },
  );
}
