/** `bevy_api` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch } from "../store.js";
import { formatRecord, toStructured } from "../format.js";
import type { BevyRecord } from "../types.js";
import type { ToolContext, VersionResolution } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_api",
    {
      title: "Look up a Bevy API symbol",
      description:
        `Exact lookup of an API item in the rustdoc index for Bevy ${config.bevyVersion ?? "UNKNOWN"}. ` +
        `Returns the real signature, full documentation, doctest examples and related items. ` +
        `Use this whenever you need to confirm a type, trait, method or function exists and how it is ` +
        `actually spelled in this version. Accepts "Query", "Query::iter", "bevy::app::App::run", ` +
        `or a pasted signature. Much more reliable than bevy_search for API questions.`,
      inputSchema: {
        symbol: z
          .string()
          .describe('Symbol to look up, e.g. "App::add_systems", "Query", "Commands::spawn".'),
        include_related: z
          .boolean()
          .optional()
          .describe("Also list other methods on the same type (default true)."),
        version: z
          .string()
          .optional()
          .describe(
            "Query a different indexed Bevy version (see bevy_indexed_versions). Defaults to the project's version.",
          ),
      },
    },
    async ({ symbol, include_related = true, version }) => {
      const res: VersionResolution = await resolveVersion(version);
      if (!res.known) return unavailableVersion(res.version, symbol);
      const idx = res.index;
      const labelVersion = version || config.bevyVersion;
      const hits = idx
        .lookupSymbol(symbol)
        .slice(0, 6);

      // Default trait methods are excluded during ingestion; use the type's
      // documented default instead of matching unrelated free functions.
      let defaultVia = null;
      const defaultOwner = symbol.match(/^(.+?)::default$/)?.[1];
      if (defaultOwner && !hits.some((h) => h.record.owner === defaultOwner)) {
        const ownerHit = idx
          .lookupSymbol(defaultOwner)
          .find((h) => h.record.defaults);
        if (ownerHit) {
          hits.length = 0;
          hits.push(ownerHit);
          defaultVia = defaultOwner;
        }
      }

      if (!hits.length) {
        const fallback = hybridSearch(idx, symbol, {
          limit: 4,
          filters: { source: "rustdoc" },
        });
        if (!fallback.length) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `No API symbol "${symbol}" in the index for Bevy ${labelVersion ?? "unknown"}.\n\n` +
                  `That index contains ${idx.stats.by_source.rustdoc ?? 0} rustdoc records from ${idx.meta?.doc_dir ?? "(no doc dir)"}.\n` +
                  `Run \`bevy_index_status\` to verify the API index is present. ` +
                  `If the API index is empty, run \`cargo doc\` in your Bevy project, or \`npm run fetch-docs\` to mirror docs.rs.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                res.note +
                `No exact symbol "${symbol}", but related API items exist.\n\n` +
                fallback.map(({ record }) => formatRecord(record)).join("\n\n---\n\n"),
            },
          ],
          structuredContent: toStructured(fallback, idx),
        };
      }

      const primary = hits[0]!;
      const parts = [
        `## Bevy ${labelVersion ?? "UNKNOWN"} - \`${primary.record.full_path}\``,
        ...(res.note ? [res.note.trim(), ""] : []),
        ...(defaultVia
          ? [
              `> \`${symbol}\` has no separately indexed \`default\` method (std trait ` +
                `impls are not indexed). Showing \`${primary.record.full_path}\`, whose ` +
                `documented default is below.`,
              "",
            ]
          : []),
        formatRecord(primary.record, { docsChars: 2500 }),
      ];

      const related: BevyRecord[] = [];
      if (include_related && primary.record.owner) {
        const relatedHits = hybridSearch(idx, primary.record.owner, {
          limit: 12,
          filters: { kind: "method", source: "rustdoc" },
        });
        for (const h of relatedHits) {
          if (h.record.id === primary.record.id) continue;
          related.push(h.record);
        }
      }

      if (hits.length > 1) {
        parts.push("", "## Other symbols matching your query", "");
        for (const h of hits.slice(1)) {
          parts.push(`- \`${h.record.full_path}\` - ${h.record.signature || h.record.kind}`);
        }
      }

      if (related.length) {
        parts.push("", `## Other methods on \`${primary.record.owner}\``, "");
        for (const r of related.slice(0, 25)) {
          parts.push(`- \`${r.name}\` - ${r.signature || "(no signature)"}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        structuredContent: {
          bevy_version: labelVersion,
          version_indexed: res.known,
          symbol: primary.record.full_path,
          signature: primary.record.signature,
          kind: primary.record.kind,
          docs: primary.record.docs,
          module: primary.record.module,
          file: primary.record.file,
          related: related.slice(0, 25).map((r) => ({
            name: r.name,
            signature: r.signature,
          })),
        },
      };
    },
  );
}
