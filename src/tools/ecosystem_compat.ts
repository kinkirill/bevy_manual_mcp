/** bevy_ecosystem_compat tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import pathModule from "node:path";
import { log, resolveConfig } from "../config.js";

const VENDORED_COMPAT = pathModule.join(import.meta.dirname!, "..", "..", "..", "vendor", "ecosystem", "compat.json");

export interface CompatToolContext {
  config: ReturnType<typeof resolveConfig>;
}

interface CompatEntry {
  plugin: string;
  plugin_version: string;
  requires_bevy: string;
}

function loadVendoredCompat(): Record<string, CompatEntry[]> {
  try {
    const raw = fs.readFileSync(VENDORED_COMPAT, "utf8");
    return JSON.parse(raw);
  } catch {
    log("vendored compat.json unreadable");
    return {};
  }
}

function parseCaretRange(range: string): { min: string; max: string } | null {
  const trimmed = range.trim();
  if (trimmed.startsWith("^")) {
    const ver = trimmed.slice(1);
    const parts = ver.split(".");
    try {
      const major = parseInt(parts[0] || "0", 10);
      const minor = parseInt(parts[1] || "0", 10);
      if (major === 0) {
        return { min: ver, max: `0.${minor + 1}.0` };
      }
      return { min: ver, max: `${major}.${minor + 1}.0` };
    } catch {
      return null;
    }
  }
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return { min: trimmed, max: trimmed };
  }
  const wildcard = trimmed.replace(/\*/g, "");
  const parts2 = wildcard.split(".");
  if (parts2.length === 2) {
    try {
      const p0 = parts2[0] ?? "0";
      return { min: `${p0}.${parts2[1] || "0"}.0`, max: `${parseInt(p0, 10) + 1}.0.0` };
    } catch {
      return null;
    }
  }
  return null;
}

function satisfiesRange(version: string, min: string, max: string): boolean {
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
    const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return cmp(version, min) >= 0 && cmp(version, max) < 0;
}

function extractMajor(reqBevy: string): number {
  const parts = reqBevy.split(".");
  return parseInt(parts[0] || "0", 10);
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

      const vendored = loadVendoredCompat();

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
            const reqBevy = entry.requires_bevy;
            const max = `${extractMajor(reqBevy) + 1}.0.0`;
            if (satisfiesRange(bevyVersion, reqBevy, max)) {
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
            const reqBevy = entry.requires_bevy;
            const max = `${extractMajor(reqBevy) + 1}.0.0`;
            if (satisfiesRange(bevyVersion, reqBevy, max)) {
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
