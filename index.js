#!/usr/bin/env node
/**
 * bevy-mcp - an MCP server that gives agents version-accurate Bevy knowledge.
 *
 * Transport is stdio, so every diagnostic goes to stderr. Anything written to
 * stdout would corrupt the JSON-RPC stream.
 *
 * Configuration (all optional, all via env):
 *   BEVY_PROJECT_ROOT   Cargo project to detect the Bevy version from
 *   BEVY_VERSION        explicit version override, e.g. 0.19.1
 *   BEVY_DOC_DIR        cargo target/doc directory (default: from project root)
 *   BEVY_WEBSITE_DIR    bevy-website checkout
 *   BEVY_SRC_DIR        bevy engine checkout (for examples/ and errors/)
 *   BEVY_MCP_OFFLINE=1  never touch the network
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveConfig, log } from "./src/config.js";
import {
  hybridSearch,
  findMigrations,
  bumpBetween,
} from "./src/store.js";
import { VersionRegistry } from "./src/registry.js";
import { MultiVersion } from "./src/multiversion.js";
import { createResources } from "./src/resources_impl.js";
import { apiUri, kindUri, crateUri, ownerUri, indexUri, isBevyUri } from "./src/resources.js";
import { createVersionChecker } from "./src/versions.js";
import {
  formatResults,
  formatRecord,
  formatStatus,
  toStructured,
  formatUpgrade,
  formatVersionDiff,
} from "./src/format.js";

/** Sort helper: oldest version first, ignoring pre-release suffixes. */
function cmpVersionForOrder(a, b) {
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Keep the MCP handshake version in lockstep with package.json instead of
// duplicating it, so a release cannot ship a mismatched self-report.
const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);
const SERVER_INFO = { name: "bevy-mcp", version: pkg.version };

const config = resolveConfig();

if (!config.bevyVersion) {
  log("WARNING: Bevy version not detected.");
  log("  ", config.versionNote || "");
  log("   Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at your Bevy Cargo project.");
}
if (!config.docDir) {
  log("WARNING: no cargo rustdoc found - API search will be limited to the book/examples.");
  log("   Run `cargo doc -p bevy` inside your Bevy project (can take several minutes).");
  log("   Or run `npm run fetch-docs` to mirror docs.rs instead.");
}

// The single most damaging failure mode for this server is answering with one
// version's API while claiming another. Detect it loudly rather than silently.
if (config.docDir && config.docVersion && config.bevyVersion) {
  const strip = (v) => String(v).split("-")[0];
  if (strip(config.docVersion) !== strip(config.bevyVersion)) {
    log("=========================================================");
    log(` VERSION MISMATCH: docs are for bevy ${config.docVersion},`);
    log(` but the project resolved to bevy ${config.bevyVersion}.`);
    log(` Results will describe ${config.docVersion} while being labelled`);
    log(` ${config.bevyVersion}. Fix BEVY_DOC_DIR, or set BEVY_VERSION.`);
    log("=========================================================");
  }
} else if (config.docDir && !config.docVersion) {
  log("note: could not determine which version these docs were built from");
  log("   (no rustdoc .lock and no fetch-docs manifest).");
}

const force = process.env.BEVY_MCP_FORCE_REINDEX === "1";
// Load the active version through the registry, which streams the ingest to
// disk. The legacy single-file loader is only a fallback.
const registry = new VersionRegistry(config);
const index = await registry.get(config.bevyVersion ?? "unversioned", {
  force,
});
const checkVersions = createVersionChecker({ offline: config.env.offline });
const multi = new MultiVersion(index);

// Extra versions, if the operator pointed us at their doc directories.
// Format: BEVY_EXTRA_VERSIONS="0.18=/path/0.18/doc,0.17=/path/0.17/doc"
for (const entry of (process.env.BEVY_EXTRA_VERSIONS || "").split(",")) {
  const [v, dir] = entry.split("=").map((s) => (s || "").trim());
  if (!v || !dir) continue;
  try {
    await multi.add(v, dir);
  } catch (err) {
    log(`multi-version: could not add ${v}: ${err.message}`);
  }
}
if (multi.extra.size) {
  log(`holding ${multi.versions().length} versions: ${multi.versions().join(", ")}`);
}

const server = new McpServer(SERVER_INFO);

const VERSION_NOTE = `Index built for Bevy ${config.bevyVersion ?? "UNKNOWN VERSION"}`;

/**
 * Resolve an explicitly requested version.
 *
 * Returns { known, scope, note, index }. `known: false` means we do not have
 * that version, so the caller must say so rather than answering from the wrong
 * version -- silently substituting the active version is exactly the failure
 * this whole server exists to prevent.
 */
async function resolveVersion(version) {
  const active = config.bevyVersion;
  if (!version || version === active) {
    return { known: true, index, scope: null, note: "" };
  }
  if (multi.has(version)) {
    return {
      known: true,
      index,
      scope: multi.scopeFor(version),
      note: multi.note(version),
    };
  }
  if (registry.has(version)) {
    const idx = await registry.get(version);
    return { known: true, index: idx, scope: null, note: "" };
  }
  return { known: false, index, scope: null, note: multi.note(version) };
}

/** Shared filter schema so every tool narrows results the same way. */
const filterShape = {
  kind: z
    .string()
    .optional()
    .describe(
      "Comma-separated record kinds, e.g. 'method,struct,fn' (API) or 'book,migration_guide,release_notes,tutorial,migration_entry,code_example' (prose).",
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Comma-separated sources: rustdoc, website, bevy-examples, learn-examples.",
    ),
  module: z
    .string()
    .optional()
    .describe("Restrict to a module path prefix, e.g. 'ecs', 'render', 'input'."),
  category: z
    .string()
    .optional()
    .describe(
      "For code examples: 2d, 3d, ui, input, audio, assets, ecs, state, render, scene, animation, text, diagnostics.",
    ),
};

const filtersOf = (args) => ({
  kind: args.kind,
  source: args.source,
  module: args.module,
  category: args.category,
});

// ---------------------------------------------------------------------------
// bevy_search - the general entry point
// ---------------------------------------------------------------------------
server.registerTool(
  "bevy_search",
  {
    title: "Search Bevy docs, API and examples",
    description:
      `Hybrid search over the Bevy API reference (rustdoc), the Bevy Book, migration guides, ` +
      `release notes and engine examples, all pinned to Bevy ${config.bevyVersion ?? "UNKNOWN"}. ` +
      `Use this for ANY question about how to do something in Bevy. Pass an exact symbol ` +
      `(e.g. "App::add_systems", "Query") to get its real signature; pass a concept ` +
      `(e.g. "system ordering", "2d camera") to get prose and examples. ` +
      `Call this before writing Bevy code - never rely on memory for signatures.`,
    inputSchema: {
      query: z
        .string()
        .describe('What to look for, e.g. "Query::iter", "add_systems ordering", "spawn ui text".'),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)."),
      version: z
        .string()
        .optional()
        .describe("Query a different indexed Bevy version (see bevy_indexed_versions)."),
      ...filterShape,
    },
  },
  async ({ query, limit = 8, version, ...rest }) => {
    const res = await resolveVersion(version);
    const results = hybridSearch(res.index, query, {
      limit,
      filters: filtersOf(rest),
      scope: res.scope,
    });
    const text =
      res.note + formatResults(res.index, results, query, { label: version || null });
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ...toStructured(results, res.index),
        queried_version: version || config.bevyVersion,
        version_indexed: res.known,
      },
    };
  },
);

// ---------------------------------------------------------------------------
// bevy_api - exact symbol lookup, the workhorse for correct signatures
// ---------------------------------------------------------------------------
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
    const res = await resolveVersion(version);
    const idx = res.index;
    const labelVersion = version || config.bevyVersion;
    const hits = idx
      .lookupSymbol(symbol)
      .filter((h) => !res.scope || h.record.source !== "rustdoc" || res.scope.has(h.record.id))
      .slice(0, 6);

    // `Type::default` is a special case. Std-trait impl methods are not indexed
    // (they are dropped as boilerplate during ingest), so a lookup of
    // `Plane3d::default` can only return unrelated free `default()` functions.
    // If the type documents its default (captured on the type record), show the
    // type instead of the free function.
    let defaultVia = null;
    const defaultOwner = symbol.match(/^(.+?)::default$/)?.[1];
    if (defaultOwner && !hits.some((h) => h.record.owner === defaultOwner)) {
      const ownerHit = idx
        .lookupSymbol(defaultOwner)
        .filter((h) => !res.scope || h.record.source !== "rustdoc" || res.scope.has(h.record.id))
        .find((h) => h.record.defaults);
      if (ownerHit) {
        hits.length = 0;
        hits.push(ownerHit);
        defaultVia = defaultOwner;
      }
    }

    if (!hits.length) {
      // An explicitly requested but unindexed version must not fall back to another
      // version's data -- that is precisely the confusion pinning exists to
      // prevent. Say what is missing instead.
      if (!res.known) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Bevy ${version} is not indexed, so I cannot answer for that version.\n\n` +
                `Indexed versions: ${multi.versions().join(", ") || "(none)"}.\n` +
                `I will not substitute a different version's API, because the answer ` +
                `would then be wrong for the version you asked about.\n\n` +
                `To add it: fetch docs for ${version} (node scripts/fetch-docs.mjs ${version}) ` +
                `and set BEVY_EXTRA_VERSIONS="${version}=<doc dir>".`,
            },
          ],
          structuredContent: {
            bevy_version: version,
            version_indexed: false,
            indexed_versions: multi.versions(),
            symbol,
          },
        };
      }

      // Fall back to full text so we still try to be useful.
      const fallback = hybridSearch(idx, symbol, {
        limit: 4,
        filters: { source: "rustdoc" },
        scope: res.scope,
      });
      if (!fallback.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No API symbol "${symbol}" in the index for Bevy ${labelVersion ?? "unknown"}.\n\n` +
                `That index contains ${idx.stats.by_source.rustdoc ?? 0} rustdoc records from ${config.docDir ?? "(no doc dir)"}.\n` +
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

    const primary = hits[0];
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

    const related = [];
    if (include_related && primary.record.owner) {
      const relatedHits = hybridSearch(idx, primary.record.owner, {
        limit: 12,
        filters: { kind: "method", source: "rustdoc" },
        scope: res.scope,
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

// ---------------------------------------------------------------------------
// bevy_examples - real runnable code
// ---------------------------------------------------------------------------
server.registerTool(
  "bevy_examples",
  {
    title: "Find Bevy code examples",
    description:
      "Finds runnable Bevy example code, either from the engine's own `examples/` directory or " +
      "from the Bevy Book's quick-start projects. Use this when you need a working pattern for a " +
      "concrete task (2D/3D rendering, UI, input, audio, assets, state, gizmos) rather than an API " +
      "signature. Returns the actual source code.",
    inputSchema: {
      task: z
        .string()
        .describe(
          'What you want to build, e.g. "2d camera", "button ui", "keyboard input", "play sound".',
        ),
      limit: z.number().int().min(1).max(15).optional(),
      category: z
        .string()
        .optional()
        .describe("Optional category filter, e.g. 'ui', '2d', 'input', 'audio'."),
    },
  },
  async ({ task, limit = 5, category }) => {
    const filters = { kind: "code_example" };
    if (category) filters.category = category;
    const results = hybridSearch(index, task, { limit, filters });
    if (!results.length) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `No examples matched "${task}".\n` +
              `The index has ${index.stats.by_kind.code_example ?? 0} examples from: ` +
              `${config.examplesDir ?? "(no bevy source/examples dir)"} and ` +
              `${config.websiteDir ?? "(no website)"}/learning-code-examples.\n` +
              `Set BEVY_SRC_DIR to a bevy checkout for the engine's full examples. ` +
              `You can also list available categories by calling this with a broad task like "2d".`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `## ${VERSION_NOTE} - examples for "${task}"\n\n` +
            results.map(({ record }) => formatRecord(record, { docsChars: 4000 })).join("\n\n---\n\n"),
        },
      ],
      structuredContent: toStructured(results, index),
    };
  },
);

// ---------------------------------------------------------------------------
// bevy_migration - breaking changes between versions
// ---------------------------------------------------------------------------
server.registerTool(
  "bevy_migration",
  {
    title: "Bevy version migration notes",
    description:
      "Returns breaking changes between two Bevy versions. Use this whenever upgrading a project, " +
      "when the user's code fails to compile, or when you are unsure whether an API changed between " +
      "releases. Includes consolidated migration guides and per-PR breaking-change notes.",
    inputSchema: {
      from_version: z
        .string()
        .optional()
        .describe("Version being upgraded from, e.g. '0.19'. Omit with to_version for a release summary."),
      to_version: z
        .string()
        .optional()
        .describe("Version being upgraded to, e.g. '0.20'."),
      topic: z
        .string()
        .optional()
        .describe('Optional filter, e.g. "scheduler", "render", "ui", "asset".'),
    },
  },
  async ({ from_version, to_version, topic }) => {
    const to = to_version || config.bevyVersion;
    if (!to) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Specify `to_version`, or set BEVY_VERSION so the server knows your target version.",
          },
        ],
      };
    }

    const all = findMigrations(index, from_version, to, { topic });
    const results = all;

    if (!results.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `No migration notes found${from_version ? ` for ${from_version} → ${to}` : ` for ${to}`}` +
              `${topic ? ` matching "${topic}"` : ""}.\n` +
              `Note: Bevy's 0.19→0.20 guide is still marked hidden upstream and contains a ` +
              `"1. TODO" placeholder, so it is incomplete. For authoritative breaking changes, ` +
              `diff the two versions' rustdoc, or check the release notes for ${to}.`,
          },
        ],
      };
    }

    const text = results
      .slice(0, 12)
      .map(({ record }) => formatRecord(record, { docsChars: 1800 }))
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text:
            `## Migration notes${from_version ? ` ${from_version} → ${to}` : ` for ${to}`}` +
            `${topic ? ` matching "${topic}"` : ""}\n\n${text}`,
        },
      ],
      structuredContent: toStructured(results.slice(0, 30), index),
    };
  },
);

// ---------------------------------------------------------------------------
// bevy_api_diff - did this API change between versions?
// ---------------------------------------------------------------------------
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
    // Everything we can actually answer for: the versions held in this process
    // (active + BEVY_EXTRA_VERSIONS) plus everything persisted in the registry.
    // Consulting only multi.versions() made this tool claim "only one version
    // is indexed" while bevy_indexed_versions happily listed the registry.
    const all = [...new Set([...multi.versions(), ...registry.versions()])].sort(
      cmpVersionForOrder,
    );

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

    // The caller names the versions. Auto-picking a pair would silently answer a
    // different question than the one asked - comparing 0.19.1->0.20.0 when the
    // user is actually moving 0.15->0.20 - which is the failure this project
    // exists to prevent. Only auto-select when there is exactly one possible
    // pair, i.e. two versions indexed.
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

    const want = versions
      ? versions.split(",").map((v) => v.trim()).filter(Boolean)
      : all;
    const unknown = want.filter((v) => !multi.has(v) && !registry.has(v));
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

    const perVersion = [];
    for (const v of want) {
      const hits = multi.has(v)
        ? multi.base
            .lookupSymbol(symbol)
            .filter(
              (h) => {
                const scope = multi.scopeFor(v);
                return !scope || h.record.source !== "rustdoc" || scope.has(h.record.id);
              })
        : (await registry.get(v)).lookupSymbol(symbol);

      // Prefer the defining module over a `prelude` re-export. The prelude page
      // has a short path, so the old "shortest path wins" rule made most types
      // look like they lived in `bevy::prelude`, which hid real module moves
      // (e.g. `Sphere` going from `bevy_math` to `bevy_shape` in 0.20).
      const pathOf = (h) => h.record.full_path || "";
      const preludeRank = (h) => (pathOf(h).includes("::prelude::") ? 1 : 0);
      const best = hits
        .slice()
        .sort((a, b) => {
          const byPrelude = preludeRank(a) - preludeRank(b);
          if (byPrelude !== 0) return byPrelude;
          return pathOf(a).length - pathOf(b).length;
        })[0];
      perVersion.push({ version: v, record: best?.record || null });
    }

    const found = perVersion.filter((p) => p.record);
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

    // rustdoc wraps signatures inconsistently between builds, so compare
    // whitespace-normalised text or identical APIs look "changed".
    const normalize = (sig) => (sig || "").replace(/\s+/g, " ").trim();
    const distinct = new Set(found.map((p) => normalize(p.record.signature)));

    // Present the comparison oldest -> newest so it reads as an upgrade path.
    const ordered = [...perVersion].sort(
      (a, b) => cmpVersionForOrder(a.version, b.version),
    );
    const bump =
      ordered.length > 1
        ? bumpBetween(ordered[0].version, ordered[ordered.length - 1].version)
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

// ---------------------------------------------------------------------------
// Resources: the completeness layer
//
// Every indexed item is readable by identity, whether or not it was ever
// full-text indexed. This is what lets the search index stay small enough to
// fit in memory while the corpus stays complete, and it is the primitive the
// MCP spec intends for large read-only datasets.
// ---------------------------------------------------------------------------
const resourceLayer = createResources({
  activeVersion: config.bevyVersion,
  versions: () => {
    const known = new Set([...multi.versions(), ...registry.versions()]);
    if (config.bevyVersion) known.add(config.bevyVersion);
    return [...known].filter(Boolean).sort(cmpVersionForOrder);
  },
  resolveVersion: async (v) => {
    if (!v || v === config.bevyVersion) return index;
    if (multi.has(v)) return index;
    if (registry.has(v)) return registry.get(v);
    return null;
  },
});

server.registerResource(
  "bevy-index",
  indexUri,
  {
    title: "Indexed Bevy versions",
    description:
      "Which Bevy versions this server can answer for, and how to construct a resource URI " +
      "for any item, type, crate or kind.",
    mimeType: "text/markdown",
  },
  async (uri) => resourceLayer.read(uri.href ?? uri.toString()),
);

// Templates are registered through the SDK's `ResourceTemplate`, which owns the
// per-variable completion callbacks (resources/complete). `list` is
// intentionally undefined: with 265k+ items, enumerating every match is not
// useful, and the paginated kind/module/crate/owner reads are the discovery
// path instead.
for (const t of resourceLayer.templates()) {
  const complete = {};
  for (const raw of t.uriTemplate.match(/\{(\w+)\}/g) || []) {
    const name = raw.slice(1, -1);
    complete[name] = (value) =>
      resourceLayer.complete(t.uriTemplate, { argument: name, value });
  }

  server.registerResource(
    t.name,
    new ResourceTemplate(t.uriTemplate, { list: undefined, complete }),
    {
      title: t.title,
      description: t.description,
      mimeType: t.mimeType,
    },
    // The callback receives the URI with template variables already substituted
    // plus the decoded variables, so one read path serves both concrete and
    // templated reads.
    async (uri, variables) => {
      const href = uri.href ?? uri.toString();
      // A list template may be continued with a cursor; carry it through so a
      // paged listing can actually be walked. The cursor is folded into the
      // content URI below, because resources/read has no nextCursor field.
      const cursor = uri.searchParams?.get("cursor") || undefined;
      const page = await resourceLayer.read(href, { cursor, variables });
      if (!page.nextCursor) return page;
      // Expose the next cursor as a query parameter on the same URI.
      const next = new URL(href);
      next.searchParams.set("cursor", page.nextCursor);
      page.contents = [{ ...page.contents[0], uri: next.href }];
      return page;
    },
  );
}

// ---------------------------------------------------------------------------
// bevy_check_version - self-renewal: is my index stale?
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// bevy_indexed_versions - what can this server answer for?
// ---------------------------------------------------------------------------
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
    const known = registry.versions();
    const all = known.includes(active) || !active ? known : [active, ...known];

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

// ---------------------------------------------------------------------------
// bevy_index_status - self-diagnosis
// ---------------------------------------------------------------------------
server.registerTool(
  "bevy_index_status",
  {
    title: "Check what the Bevy index contains",
    description:
      "Reports which Bevy version is indexed, how many records exist, and which source directories " +
      "were found. Call this first if search results look wrong, empty, or from the wrong version - " +
      "it is the fastest way to find out whether the API index is missing entirely.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: formatStatus(index, config) }],
    structuredContent: {
      bevy_version: config.bevyVersion,
      doc_version: config.docVersion,
      version_mismatch:
        !!(config.docVersion && config.bevyVersion) &&
        config.docVersion.split("-")[0] !== config.bevyVersion.split("-")[0],
      version_source: config.versionSource,
      project_root: config.projectRoot,
      doc_dir: config.docDir,
      website_dir: config.websiteDir,
      examples_dir: config.examplesDir,
      stats: index.stats,
      symbols: index.meta?.symbols,
      built_at: index.meta?.built_at,
      has_api_index: (index.stats.by_source.rustdoc ?? 0) > 0,
    },
  }),
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready - ${SERVER_INFO.name} ${SERVER_INFO.version}, bevy ${config.bevyVersion ?? "?"}`);

/**
 * Self-renewal notice.
 *
 * Runs *after* connect so it can never delay or break the handshake, and only
 * logs to stderr -- a background notice must not become noise inside the MCP
 * protocol stream. If the host project is behind, say so once, clearly.
 *
 * A patch release is deliberately NOT worth interrupting for: it changes no
 * APIs, so the agent has no reason to touch the user's code.
 */
if (config.bevyVersion && !config.env.offline) {
  checkVersions()
    .then((info) => {
      if (!info.ok) return; // silent: network trouble is not the agent's problem
      const bump = bumpBetween(config.bevyVersion, info.newest_stable);
      if (bump.level === "none") return;

      if (!bump.breaksApi) {
        log(
          `note: bevy ${info.newest_stable} is available (patch release, no API changes). ` +
            `Your index for ${config.bevyVersion} is still accurate.`,
        );
      } else {
        log(
          `*** Bevy ${info.newest_stable} is available and your project is on ` +
            `${config.bevyVersion}. This is a BREAKING release. ***`,
        );
        log(
          `    This index only describes ${config.bevyVersion}. Use bevy_check_version ` +
            `and bevy_migration before suggesting API changes.`,
        );
      }
      if (info.preview && info.preview !== info.newest_stable) {
        log(`    (${info.preview} is a pre-release; not recommended.)`);
      }
    })
    .catch(() => {
      /* never let a background check break startup */
    });
}
