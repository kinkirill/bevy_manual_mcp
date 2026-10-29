/** bevy_ecosystem_compat tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CompatibilityEntry } from "../analysis/compat.js";
import { compareVersions, evaluateRequirement, loadVendoredCompatSnapshot } from "../analysis/compat.js";
import type { resolveConfig } from "../config.js";

export interface CompatToolContext {
  config: ReturnType<typeof resolveConfig>;
  /** Test seam: an alternate compat snapshot; defaults to the vendored file. */
  compatPath?: string | null;
}

type Verdict = "compatible" | "incompatible" | "unknown";

interface PluginVerdict {
  crate: string;
  verdict: Verdict;
  matching: CompatibilityEntry[];
  unsupported: CompatibilityEntry[];
  newest: CompatibilityEntry | null;
  available: string[];
}

function assess(crate: string, entries: CompatibilityEntry[], bevyVersion: string | null): PluginVerdict {
  // The snapshot is newest-first, but never trust ordering for the answer.
  const ordered = [...entries].sort((a, b) => compareVersions(b.plugin_version, a.plugin_version));
  const matching: CompatibilityEntry[] = [];
  const unsupported: CompatibilityEntry[] = [];
  if (bevyVersion) {
    for (const entry of ordered) {
      const result = evaluateRequirement(entry.requires_bevy, bevyVersion);
      if (result === "satisfied") matching.push(entry);
      else if (result === "unknown") unsupported.push(entry);
    }
  }
  const verdict: Verdict = !bevyVersion ? "unknown"
    : matching.length ? "compatible"
    : unsupported.length ? "unknown"
    : "incompatible";
  return {
    crate, verdict, matching, unsupported,
    newest: ordered[0] ?? null,
    available: [...new Set(ordered.map((entry) => entry.plugin_version))],
  };
}

function requirementOf(entry: CompatibilityEntry | null): string {
  return entry ? (entry.requires_bevy || "(no requirement)") : "(none)";
}

export function register(server: McpServer, ctx: CompatToolContext): void {
  const { config } = ctx;

  server.registerTool(
    "bevy_ecosystem_compat",
    {
      title: "Check plugin compatibility with the pinned Bevy version",
      description:
        "Answers both directions of the compatibility question: which published plugin versions declare " +
        "compatibility with the pinned Bevy version, and what Bevy requirement a plugin release states. " +
        "Answers from the vendored snapshot (`vendor/ecosystem/compat.json`) entirely offline; it does " +
        "not contact crates.io. Never answers from a neighbouring Bevy version index. The verdict is " +
        "tri-state: `compatible`, `incompatible`, or `unknown` (no pinned version, or a requirement " +
        "expression this tool cannot evaluate). Matching versions are candidates from published " +
        "declarations, not proof that an already-installed release matches.",
      inputSchema: {
        crate: z.string().optional().describe("Plugin crate name e.g. bevy_egui. Omit to check all."),
      },
    },
    async ({ crate }) => {
      const bevyVersion = config.bevyVersion;
      const snapshot = loadVendoredCompatSnapshot(ctx.compatPath);
      const vendored = snapshot.plugins;

      if (crate) {
        const entries = vendored[crate];
        if (!entries || !entries.length) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Warning: No compat data for \`${crate}\`.\n\nAvailable plugins: ${Object.keys(vendored).join(", ") || "(none)"}\n`,
            }],
            structuredContent: { crate, bevy_version: bevyVersion, verdict: "unknown", compatible: null, available_plugins: Object.keys(vendored) },
          };
        }

        const result = assess(crate, entries, bevyVersion);
        let output = "## Plugin Compatibility\n\n";
        if (result.verdict === "compatible") {
          output += `[OK] \`${crate}\` declares compatibility with Bevy ${bevyVersion}.\n\n`;
          output += "Matching published versions (candidates):\n";
          for (const entry of result.matching) output += `- \`${entry.plugin_version}\` requires \`${entry.requires_bevy}\`\n`;
          output += `\n_These are published compatibility declarations. They do not prove that the plugin release already installed in your project matches._\n`;
        } else if (result.verdict === "unknown") {
          output += `[?] Cannot determine whether \`${crate}\` supports Bevy ${bevyVersion ?? "(unknown)"}.\n\n`;
          if (!bevyVersion) {
            output += "No Bevy version is pinned, so there is nothing to compare against.\n";
          } else if (result.unsupported.length) {
            output += `Requirements this tool cannot evaluate: ${result.unsupported.map((entry) => `\`${entry.plugin_version}\` (\`${entry.requires_bevy}\`)`).join(", ")}.\n`;
          }
          if (result.newest) output += `\nNewest published release: \`${result.newest.plugin_version}\` requires \`${requirementOf(result.newest)}\`.`;
          output += "\n";
        } else {
          output += `[WARN] \`${crate}\` has no published version that declares compatibility with Bevy ${bevyVersion}.\n\n`;
          if (result.newest) {
            output += `Newest release: \`${result.newest.plugin_version}\` requires \`${requirementOf(result.newest)}\`.\n`;
          }
          output += `Available versions: ${result.available.join(", ")}\n`;
        }

        return {
          content: [{ type: "text", text: output.trimEnd() }],
          structuredContent: {
            crate,
            bevy_version: bevyVersion,
            compatible: result.verdict === "compatible" ? true : result.verdict === "incompatible" ? false : null,
            verdict: result.verdict,
            matching_versions: result.matching.map((entry) => entry.plugin_version),
            candidates: result.matching.map((entry) => ({ version: entry.plugin_version, requires_bevy: entry.requires_bevy })),
            unsupported_requirements: result.unsupported.map((entry) => ({ version: entry.plugin_version, requires_bevy: entry.requires_bevy })),
            newest: result.newest ? { version: result.newest.plugin_version, requires_bevy: result.newest.requires_bevy } : null,
            available_versions: result.available,
            provenance: snapshot.meta,
          },
        };
      }

      // No specific crate — show the compatibility matrix.
      const crates = Object.entries(vendored).map(([name, entries]) => assess(name, entries, bevyVersion));
      let output = "## Plugin Compatibility\n\n";
      if (bevyVersion) {
        output += `For Bevy ${bevyVersion}:\n\n`;
        for (const result of crates) {
          const marker = result.verdict === "compatible" ? "[OK]" : result.verdict === "unknown" ? "[?]" : "[WARN]";
          output += `${marker} \`${result.crate}\`: ` +
            (result.matching.length ? result.matching.map((entry) => entry.plugin_version).join(", ") : "(no matching version)") + "\n";
        }
      } else {
        output += "No Bevy version pinned.\n\n";
        for (const result of crates) output += `- \`${result.crate}\`: ${result.available.join(", ")}\n`;
      }
      if (snapshot.meta.complete === false) {
        output += `\n> ⚠ The compatibility snapshot is marked incomplete (${snapshot.meta.version_count} versions, harvested ${snapshot.meta.harvested_at ?? "unknown"}).\n`;
      }

      return {
        content: [{ type: "text", text: output.trimEnd() }],
        structuredContent: {
          bevy_version: bevyVersion,
          crates_available: Object.keys(vendored),
          crates: Object.fromEntries(crates.map((result) => [result.crate, {
            verdict: result.verdict,
            matching_versions: result.matching.map((entry) => entry.plugin_version),
          }])),
          provenance: snapshot.meta,
        },
      };
    },
  );
}
