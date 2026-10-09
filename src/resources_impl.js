/**
 * Resource handlers.
 *
 * Turns a parsed bevy:// URI into MCP resource contents. This is the
 * completeness layer of the server: an item is readable here whether or not it
 * was ever full-text indexed, which is what allows the search index to stay
 * small enough to fit in memory.
 */

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

/** JSON-RPC "invalid params", used for a URI that parses but names nothing. */
function invalidParams(message, data) {
  const err = new Error(message);
  err.code = -32602;
  if (data) err.data = data;
  return err;
}

function textContent(uri, text) {
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
function bareUri(uri) {
  const s = String(uri);
  const i = s.indexOf("?");
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Build the resource layer for a set of indexes.
 *
 * @param resolveVersion  async (version) => index | null
 * @param activeVersion   the project's pinned version
 */
export function createResources({ resolveVersion, activeVersion, versions }) {
  /**
   * Handle one resources/read request.
   * Throws a JSON-RPC-shaped error for a bad or unknown URI.
   */
  async function read(uri, { cursor } = {}) {
    if (!isBevyUri(uri)) {
      throw invalidParams(`Not a bevy resource URI: ${uri}`, { uri });
    }
    const href = bareUri(uri);
    const q = parseUri(href);
    if (!q) throw invalidParams(`Malformed bevy URI: ${uri}`, { uri });

    // A cursor may arrive as a `?cursor=` query parameter on the URI itself,
    // which is how a paginated listing is continued.
    if (!cursor && typeof uri === "string") {
      const qIdx = uri.indexOf("?cursor=");
      if (qIdx !== -1) cursor = decodeURIComponent(uri.slice(qIdx + 8).split("&")[0]);
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
            `No items matched ${q.type}="${q[q.type]}" in Bevy ${q.version}.`,
            { uri },
          );
        }
        // Sort so pagination is stable across requests.
        matches.sort((a, b) => a.full_path.localeCompare(b.full_path));
        const page = paginate(matches, q, cursor);

        const listing = [
          `# Bevy ${q.version} - ${q.type}: ${q[q.type]}`,
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

      default:
        throw invalidParams(`Unsupported bevy URI type: ${q.type}`, { uri });
    }
  }

  /**
   * Completion for the resource templates, so an interactive client can
   * discover valid version / kind / crate values as the user types.
   */
  async function complete(uriTemplate, { argument, value }) {
    const all = versions();
    const v = String(value ?? "");

    if (uriTemplate.includes("{version}")) {
      const matches = all.filter((x) => x.toLowerCase().startsWith(v.toLowerCase()));
      return matches;
    }
    if (uriTemplate.includes("{kind}")) {
      const kinds = [
        "struct", "enum", "trait", "fn", "method",
        "associated_type", "associated_const", "type", "constant", "macro",
      ];
      return kinds.filter((k) => k.startsWith(v.toLowerCase()));
    }
    if (uriTemplate.includes("{crate}")) {
      const idx = await resolveVersion(activeVersion);
      const crates = idx ? cratesIn(idx) : [];
      return crates.filter((c) => c.toLowerCase().startsWith(v.toLowerCase()));
    }
    return [];
  }

  return { read, complete, templates: () => templates(activeVersion), indexUri };
}
