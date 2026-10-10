/** Read indexed items by identity, including records excluded from full-text search. */

import {
  parseUri,
  isBevyUri,
  apiUri,
  kindUri,
  moduleUri,
  crateUri,
  ownerUri,
  fileUri,
  indexUri,
  templates,
} from "./resources.js";
import { queryRecords, findByPath, cratesIn } from "./store.js";
import { paginate } from "./pagination.js";
import { formatRecord } from "./format.js";
import { bumpBetween } from "./store.js";
import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { BevyIndex } from "./store.js";
import type { ResourceQuery } from "./types.js";

function invalidParams(message: string, data?: unknown) {
  return new McpError(ErrorCode.InvalidParams, message, data);
}

function textContent(uri: string, text: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text,
      },
    ],
  };
}

/** Strip any query string; the query parser only looks at the path. */
function bareUri(uri: string) {
  const s = String(uri);
  const i = s.indexOf("?");
  return i === -1 ? s : s.slice(0, i);
}

export interface ResourceDependencies {
  resolveVersion: (version: string | null | undefined) => Promise<BevyIndex | null>;
  activeVersion: string | null;
  versions: () => string[];
}
export type ResourceReadResult = ReadResourceResult & { nextCursor?: string; ttlMs?: number; cacheScope?: string };
function queryValue(query: ResourceQuery): string {
  switch (query.type) {
    case "api": return query.path;
    case "kind": return query.kind;
    case "module": return query.module;
    case "crate": return query.crate;
    case "owner": return query.owner;
    case "doc": return query.file;
    case "index": return "versions";
  }
}
/** Bind resource reads and completions to the version registry. */
export function createResources({ resolveVersion, activeVersion, versions }: ResourceDependencies) {
  /** Read a resource or reject malformed/unknown URIs with InvalidParams. */
  async function read(uri: string, { cursor }: { cursor?: string; variables?: unknown } = {}): Promise<ResourceReadResult> {
    if (!isBevyUri(uri)) {
      throw invalidParams(`Not a bevy resource URI: ${uri}`, { uri });
    }
    const href = bareUri(uri);
    const q = parseUri(href);
    if (!q) throw invalidParams(`Malformed bevy URI: ${uri}`, { uri });

    // Continuation cursors can also be encoded in resource URIs.
    if (!cursor && typeof uri === "string") {
      cursor = new URL(uri).searchParams.get("cursor") ?? undefined;
    }

    if (q.type === "index") {
      return textContent(
        uri,
        [
          "# Indexed Bevy versions",
          "",
          `Active (from the host project's Cargo.lock): **${activeVersion ?? "UNKNOWN"}**`,
          "",
          "| version | available |",
          "|---|---|",
          ...versions().map(
            (v) =>
              `| ${v} | ${v === activeVersion ? "**active**" : "yes"}${bumpBetween(activeVersion, v).breaksApi ? " (breaking change from active)" : ""} |`,
          ),
          "",
          "Read an item with:",
          `- \`${apiUri("<version>", "<full::path>")}\``,
          `- \`${ownerUri("<version>", "<TypeName>")}\` - everything on one type`,
          `- \`${crateUri("<version>", "bevy_render")}\` - a whole sub-crate`,
          `- \`${kindUri("<version>", "method")}\` - every method`,
        ].join("\n"),
      );
    }

    const index = await resolveVersion(q.version);
    if (!index) {
      throw invalidParams(
        `Bevy ${q.version} is not indexed. Available: ${versions().join(", ")}`,
        { uri, available: versions() },
      );
    }

    switch (q.type) {
      case "api": {
        const rec = findByPath(index, q.version, q.path);
        if (!rec) {
          throw invalidParams(
            `No API item at "${q.path}" in Bevy ${q.version}.`,
            { uri, hint: "Check the path, or search with the bevy_search tool." },
          );
        }
        const body = [
          `> Read from \`${uri}\` · Bevy ${q.version}`,
          "",
          formatRecord(rec, { docsChars: 4000 }),
        ].join("\n");
        return { ...textContent(uri, body), ttlMs: 600000, cacheScope: "public" };
      }

      case "kind":
      case "module":
      case "crate":
      case "owner":
      case "doc": {
        const matches = queryRecords(index, q);
        if (!matches.length) {
          throw invalidParams(
            `No items matched ${q.type}="${queryValue(q)}" in Bevy ${q.version}.`,
            { uri },
          );
        }
        // Sort so pagination is stable across requests.
        matches.sort((a, b) => a.full_path.localeCompare(b.full_path));
        const page = paginate(matches, q, cursor);

        const listing = [
          `# Bevy ${q.version} - ${q.type}: ${queryValue(q)}`,
          "",
          `_${page.total} item(s), showing ${page.items.length}. ` +
            `Paged; re-read with \`cursor\` to continue._`,
          "",
          ...page.items.map((r) => {
            const u = apiUri(q.version, r.full_path);
            const sig = r.signature ? ` - \`${r.signature.replace(/\s+/g, " ").slice(0, 110)}\`` : "";
            return `- [\`${r.kind}\`] **${r.name}**${sig}\n  \`${u}\``;
          }),
        ].join("\n");

        return {
          contents: [
            { uri, mimeType: "text/markdown", text: listing },
          ],
          nextCursor: page.nextCursor,
          ttlMs: 60000,
          cacheScope: "public",
          _meta: { total: page.total, pageSize: page.pageSize },
        };
      }

    }
  }

  /** Complete template arguments using the requested version's indexed values. */
  async function complete(uriTemplate: string, { argument, value, context }: {
    argument: string;
    value: string;
    context?: { arguments?: Record<string, string> };
  }): Promise<string[]> {
    const all = versions();
    const v = String(value ?? "");

    if (!uriTemplate.includes(`{${argument}}`)) return [];
    if (argument === "version") {
      const matches = all.filter((x) => x.toLowerCase().startsWith(v.toLowerCase()));
      return matches;
    }
    if (argument === "kind") {
      const kinds = [
        "struct", "enum", "trait", "fn", "method",
        "associated_type", "associated_const", "type", "constant", "macro", "field", "variant",
      ];
      return kinds.filter((k) => k.startsWith(v.toLowerCase()));
    }
    const selectedVersion = context?.arguments?.version ?? activeVersion;
    const idx = await resolveVersion(selectedVersion);
    if (!idx) return [];
    let candidates: string[];
    switch (argument) {
      case "crate": candidates = cratesIn(idx); break;
      case "path": candidates = idx.records.filter((r) => r.source === "rustdoc").map((r) => r.full_path); break;
      case "module": candidates = idx.records.map((r) => r.module); break;
      case "owner": candidates = idx.records.flatMap((r) => r.owner ? [r.owner] : []); break;
      case "file": candidates = idx.records.map((r) => r.file); break;
      default: return [];
    }
    return [...new Set(candidates)].filter((candidate) => candidate.toLowerCase().startsWith(v.toLowerCase())).sort();
  }

  return { read, complete, templates: () => templates(activeVersion), indexUri };
}
