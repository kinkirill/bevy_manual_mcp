/** bevy_ecosystem_search tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, type BevyIndex } from "../store.js";

/** A corpus that is loaded and ready to search. */
export interface EcosystemCorpus {
  /** Corpus ID, e.g. "bevy@0.20.0" or "bevy_egui@0.43.1". */
  id: string;
  /** Owning crate, e.g. "bevy" or "bevy_egui". */
  crate: string;
  /** Indexed crate version. */
  version: string | null;
  /** Provenance label, e.g. "bevy-index", "docs.rs" or "local rustdoc". */
  source: string;
  index: BevyIndex;
}

/** A configured corpus that could not be loaded. */
export interface EcosystemFailure {
  id: string;
  crate: string;
  version: string | null;
  reason: string;
}

export interface EcosystemToolContext {
  config: Record<string, unknown> & { bevyVersion?: string | null };
  /** Loaded corpora (the primary Bevy index plus configured plugin corpora). */
  corpora?: EcosystemCorpus[];
  /** Configured corpora that failed to load. */
  failures?: EcosystemFailure[];
  /** Whether the user configured any plugin corpora at all. */
  configured?: boolean;
}

function provenance(corpus: EcosystemCorpus): string {
  return `${corpus.crate}@${corpus.version ?? "?"} · ${corpus.source}`;
}

export function register(server: McpServer, ctx: EcosystemToolContext): void {
  const { config } = ctx;

  server.registerTool(
    "bevy_ecosystem_search",
    {
      title: "Search across indexed ecosystem corpora",
      description:
        "Fans out search across the primary Bevy index and every configured plugin corpus. " +
        "Every result is labelled with its crate namespace so that egui::Button and bevy_ui::Button " +
        "stay distinct. Structured output lists the corpora that were actually searched and any " +
        "configured corpus that failed to load. The optional `crate` parameter restricts the search " +
        "to one corpus.",
      inputSchema: {
        query: z.string().describe("Search query for API symbols types or concepts."),
        crate: z.string().optional().describe('Restrict to one crate e.g. bevy_egui. Omit to search all.'),
        limit: z.number().int().min(1).max(20).optional().describe("Max results per corpus default 8."),
      },
    },
    async ({ query, crate, limit = 8 }) => {
      const corpora = ctx.corpora ?? [];
      const failures = ctx.failures ?? [];
      const pluginCorpora = corpora.filter((corpus) => corpus.crate !== "bevy");
      const configured = ctx.configured ?? (pluginCorpora.length > 0 || failures.length > 0);

      const failurePayload = failures.map((failure) => ({
        id: failure.id,
        crate: failure.crate,
        version: failure.version,
        reason: failure.reason,
      }));

      // --- Restrict to one crate -------------------------------------------
      let selected: EcosystemCorpus[];
      if (crate) {
        selected = corpora.filter((corpus) => corpus.crate === crate || corpus.id.startsWith(`${crate}@`));
        if (!selected.length) {
          const failed = failures.find((failure) => failure.crate === crate);
          const available = corpora.map((corpus) => corpus.id);
          const text = failed
            ? `Corpus \`${crate}\` is configured but could not be loaded: ${failed.reason}.\n\n` +
              `Loaded corpora: ${available.join(", ") || "(none)"}.`
            : `No configured corpus matches \`${crate}\`.\n\n` +
              `Configured corpora: ${available.join(", ") || "(none)"}.` +
              (failures.length ? `\nFailed corpora: ${failures.map((f) => `${f.id} (${f.reason})`).join(", ")}.` : "");
          return {
            isError: true,
            content: [{ type: "text", text }],
            structuredContent: {
              query,
              crate,
              corpora_searched: [],
              corpora: [],
              total_hits: 0,
              failures: failurePayload,
              available_corpora: available,
              bevy_version: config.bevyVersion ?? null,
            },
          };
        }
      } else {
        selected = corpora;
      }

      // --- Search ----------------------------------------------------------
      const searched = selected.map((corpus) => {
        const hits = hybridSearch(corpus.index, query, { limit });
        return { corpus, hits };
      });
      const totalHits = searched.reduce((sum, entry) => sum + entry.hits.length, 0);

      let output = "## Ecosystem Search Results\n\n";
      if (!selected.length) {
        output += "No corpora are configured to search. Add a `corpora` entry to `bevy-mcp.config.json` " +
          "or install a Bevy index, then retry.\n";
      } else {
        for (const { corpus, hits } of searched) {
          output += `### \`${corpus.id}\` — ${provenance(corpus)}\n\n`;
          if (!hits.length) {
            output += "_No results in this corpus._\n\n";
            continue;
          }
          for (const hit of hits.slice(0, limit)) {
            const record = hit.record;
            output += `- \`${record.full_path || record.name}\` — **[${record.kind}]**\n`;
            if (record.docs) {
              const snippet = record.docs.slice(0, 200).replace(/\n\s*\n/g, "\n").trim();
              output += `  ${snippet}\n`;
            }
          }
          output += "\n";
        }
      }

      if (!crate && !pluginCorpora.length && !failures.length) {
        output += `_No plugin corpora are configured; searched the Bevy index only. ` +
          `Add a \`corpora\` entry to include a plugin._\n\n`;
      }

      if (failures.length) {
        output += "### Configured corpora that failed to load\n\n";
        for (const failure of failures) {
          output += `- \`${failure.id}\`: ${failure.reason}\n`;
        }
        output += "\n";
      }

      return {
        content: [{ type: "text", text: output.trimEnd() }],
        structuredContent: {
          query,
          bevy_version: config.bevyVersion ?? null,
          corpora_searched: searched.map((entry) => entry.corpus.id),
          corpora: searched.map((entry) => ({
            id: entry.corpus.id,
            crate: entry.corpus.crate,
            version: entry.corpus.version,
            source: entry.corpus.source,
            hits: entry.hits.length,
            top: entry.hits[0]?.record.full_path ?? null,
          })),
          total_hits: totalHits,
          failures: failurePayload,
          plugin_corpora_configured: pluginCorpora.length,
          configured,
        },
      };
    },
  );
}
