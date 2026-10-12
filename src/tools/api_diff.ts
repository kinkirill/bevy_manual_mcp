/** `bevy_api_diff` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bumpBetween, cmpVersion } from "../store.js";
import { formatVersionDiff } from "../format.js";
import type { BevyRecord, SearchHit } from "../types.js";
import type { ToolContext, VersionResolution } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, registry, index, resolveVersion, indexedVersions, unavailableVersion } = ctx;
  const cmpVersionForOrder = cmpVersion;

  server.registerTool(
    "bevy_api_diff",
    {
      title: "Compare a Bevy symbol across versions",
      description:
        "Shows the same API symbol as it exists in each indexed Bevy version, and states plainly " +
        "whether the signature changed. Use this during an upgrade to decide whether a specific " +
        "call site actually needs rewriting, instead of guessing from a migration guide. " +
        "If only patch versions are indexed the answer will be 'identical', which is the correct " +
        "and useful result: patch releases do not change APIs. Call bevy_indexed_versions first " +
        "to see what is available.",
      inputSchema: {
        symbol: z
          .string()
          .describe('Symbol to compare, e.g. "App::add_systems", "Query", "Camera2d".'),
        versions: z
          .string()
          .optional()
          .describe(
            'Comma-separated versions to compare, e.g. "0.19.1,0.20.0". Required whenever ' +
              "more than two versions are indexed; with exactly two they are compared automatically.",
          ),
      },
    },
    async ({ symbol, versions }) => {
      const all = indexedVersions();

      const want = versions
        ? [...new Set(versions.split(",").map((v) => v.trim()).filter(Boolean))]
        : all;
      const unknown = want.filter((v) => !registry.has(v));
      if (unknown.length && versions) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Not indexed: ${unknown.join(", ")}.\n` +
                `Indexed versions: ${all.join(", ")}.\n` +
                `Refusing to substitute another version's API, since that would defeat the ` +
                `purpose of pinning.`,
            },
          ],
        };
      }
      if (all.length < 2) {
        return {
          content: [
            {
              type: "text",
              text:
                `Only one Bevy version is indexed (${all[0] ?? "none"}), so there is nothing to ` +
                `compare.\n\nAdd another with:\n` +
                `  bevy-mcp fetch-index <version>\n` +
                `or point at a local doc tree:\n` +
                `  BEVY_EXTRA_VERSIONS="0.18.1=/path/to/0.18.1/target/doc" node index.js`,
            },
          ],
          structuredContent: { symbol, comparable: false, indexed: all },
        };
      }

      if (want.length < 2) {
        return {
          isError: true,
          content: [{ type: "text", text: "Choose at least two distinct indexed Bevy versions to compare." }],
          structuredContent: { symbol, comparable: false, needs_versions: true, indexed: all },
        };
      }

      // Infer comparison versions only when exactly one pair is available.
      if (!versions && all.length !== 2) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `${all.length} Bevy versions are indexed, so which pair to compare is ambiguous. ` +
                `Name them explicitly:\n\n` +
                `  versions: "${all[0]},${all[all.length - 1]}"\n\n` +
                `Indexed: ${all.join(", ")}.`,
            },
          ],
          structuredContent: {
            symbol,
            comparable: false,
            needs_versions: true,
            indexed: all,
          },
        };
      }

      const perVersion: { version: string; record: BevyRecord | null }[] = [];
      for (const v of want) {
        const resolved: VersionResolution = await resolveVersion(v);
        if (!resolved.known) return unavailableVersion(v, symbol);
        const hits = resolved.index.lookupSymbol(symbol);

        // Prefer defining modules so prelude reexports do not hide module moves.
        const pathOf = (h: SearchHit) => h.record.full_path || "";
        const preludeRank = (h: SearchHit) => (pathOf(h).includes("::prelude::") ? 1 : 0);
        const best = hits
          .slice()
          .sort((a, b) => {
            const byPrelude = preludeRank(a) - preludeRank(b);
            if (byPrelude !== 0) return byPrelude;
            return pathOf(a).length - pathOf(b).length;
          })[0];
        perVersion.push({ version: v, record: best?.record || null });
      }

      const found = perVersion.filter((p): p is { version: string; record: BevyRecord } => p.record !== null);
      if (!found.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `"${symbol}" was not found in any indexed version (${all.join(", ")}).`,
            },
          ],
        };
      }

      // Normalize rustdoc line wrapping before comparing signatures.
      const normalize = (sig: string | null | undefined) => (sig || "").replace(/\s+/g, " ").trim();
      const distinct = new Set(found.map((p) => normalize(p.record.signature)));

      const ordered = [...perVersion].sort(
        (a, b) => cmpVersionForOrder(a.version, b.version),
      );
      const bump =
        ordered.length > 1
          ? bumpBetween(ordered[0]!.version, ordered[ordered.length - 1]!.version)
          : null;

      const lo = ordered[0]?.version;
      const hi = ordered[ordered.length - 1]?.version;

      const text =
        formatVersionDiff({ symbol, perVersion: ordered }) +
        (bump && bump.breaksApi && distinct.size === 1
          ? `\n\n_Note: ${lo} → ${hi} is a breaking release overall, but this particular ` +
            `symbol's signature is unchanged. Other APIs around it probably did change - ` +
            `check bevy_migration before assuming your whole project is safe._\n`
          : "");

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          symbol,
          comparable: true,
          changed: distinct.size > 1,
          versions: perVersion.map((p) => ({
            version: p.version,
            found: !!p.record,
            signature: p.record?.signature || null,
            module: p.record?.module || null,
          })),
          release_is_breaking: bump?.breaksApi ?? null,
        },
      };
    },
  );
}
