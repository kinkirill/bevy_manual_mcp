/** `bevy_indexed_versions` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bumpBetween } from "../store.js";
import type { ToolContext } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, registry, index, indexedVersions } = ctx;

  server.registerTool(
    "bevy_indexed_versions",
    {
      title: "List indexed Bevy versions",
      description:
        "Lists every Bevy version this server has an index for, marking which one is active. " +
        "Use this to discover whether you can compare APIs across versions (for example to show " +
        "a user how a signature differs between two releases). The active version is the one " +
        "matching the host project's Cargo.lock.",
      inputSchema: {},
    },
    async () => {
      const active = config.bevyVersion;
      const known = indexedVersions();
      const all = !active || known.includes(active) ? known : [active, ...known];

      const rows = all.map((v) => {
        const info = registry.registry.versions[String(v).replace(/[^a-zA-Z0-9._+-]/g, "_")];
        const bump = v === active ? null : bumpBetween(active, v);
        return {
          version: v,
          active: v === active,
          records: info?.records ?? (v === active ? index.records.length : null),
          symbols: info?.symbols ?? null,
          built_at: info?.built_at ?? null,
          relative_to_active: bump
            ? { level: bump.level, breaks_api: bump.breaksApi, direction: bump.direction }
            : null,
        };
      });

      const lines = [
        `# Indexed Bevy versions`,
        ``,
        `**Active:** ${active ?? "UNKNOWN"} (from ${config.versionSource ?? "n/a"})`,
        ``,
        `| version | active | records | symbols | vs active |`,
        `|---|---|---|---|---|`,
        ...rows.map(
          (r) =>
            `| ${r.version} | ${r.active ? "**yes**" : ""} | ${r.records ?? "-"} | ` +
            `${r.symbols ?? "-"} | ${r.relative_to_active ? `${r.relative_to_active.level}${r.relative_to_active.breaks_api ? " (breaking)" : ""}` : "-"} |`,
        ),
      ];

      const others = rows.filter((r) => !r.active);
      if (others.length) {
        lines.push(
          ``,
          `You can pass \`version\` to \`bevy_api\` and \`bevy_search\` to query any of these.`,
        );
      } else {
        lines.push(
          ``,
          `_Only one version is indexed. To add another:_`,
          ``,
          `- \`node scripts/fetch-docs.mjs <version>\` then \`BEVY_VERSION=<version>\`, or`,
          `- run \`cargo doc\` in a project pinned to that version.`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { active, versions: rows },
      };
    },
  );
}
