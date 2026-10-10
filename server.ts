#!/usr/bin/env node
/** Stdio diagnostics must use stderr to preserve the JSON-RPC transport. */

import fs from "node:fs";
import path from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { resolveConfig, log, PACKAGE_ROOT } from "./src/config.js";
import {
  hybridSearch,
  findMigrations,
  bumpBetween,
  BevyIndex,
} from "./src/store.js";
import { VersionRegistry, compareVersions } from "./src/registry.js";
import { createResources } from "./src/resources_impl.js";
import { apiUri } from "./src/resources.js";
import { createVersionChecker } from "./src/versions.js";
import {
  formatResults,
  formatRecord,
  formatStatus,
  toStructured,
  formatVersionDiff,
} from "./src/format.js";
import type { ResolvedConfig, SearchHit, BevyRecord } from "./src/types.js";
import { errorMessage } from "./src/types.js";

const cmpVersionForOrder = compareVersions;

// Read the handshake version from package.json to keep release metadata consistent.
const pkg = z.object({ version: z.string() }).parse(JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
));
const SERVER_INFO = { name: "bevy-mcp", version: pkg.version };

export interface ServerOptions {
  force?: boolean;
  extraVersions?: string;
}

/** Construct the MCP server without opening a transport or checking the network. */
export async function createBevyServer(config: ResolvedConfig = resolveConfig(), options: ServerOptions = {}) {

  if (!config.bevyVersion) {
    log("WARNING: Bevy version not detected.");
    log("  ", config.versionNote || "");
    log("   Set BEVY_VERSION, or point BEVY_PROJECT_ROOT at your Bevy Cargo project.");
  }

  // Flag documentation whose version differs from the host project.
  if (config.docDir && config.docVersion && config.bevyVersion) {
    const strip = (v: string) => v.split("-")[0];
    if (strip(config.docVersion) !== strip(config.bevyVersion)) {
      log("=========================================================");
      log(` VERSION MISMATCH: docs are for bevy ${config.docVersion},`);
      log(` but the project resolved to bevy ${config.bevyVersion}.`);
      log(` Refusing to build an index with mismatched documentation.`);
      log(` Fix BEVY_DOC_DIR, or set BEVY_VERSION.`);
      log("=========================================================");
    }
  } else if (config.docDir && !config.docVersion) {
    log("note: could not determine which version these docs were built from");
    log("   (no rustdoc .lock and no fetch-docs manifest).");
  }

  const force = options.force ?? process.env.BEVY_MCP_FORCE_REINDEX === "1";
  const registry = new VersionRegistry(config);
  const index = await registry.get(config.bevyVersion ?? "unversioned", {
    force,
  });
  if (!config.docDir && !index.stats.by_source.rustdoc) {
    log("WARNING: no API index is installed - search is limited to the book/examples.");
    log("   Run `bevy-mcp fetch-index <version>` to install a published index.");
    log("   Or run `npm run fetch-docs` to mirror docs.rs and build it locally.");
  }
  const checkVersions = createVersionChecker({ offline: config.env.offline });

  // BEVY_EXTRA_VERSIONS contains comma-separated version=doc-directory pairs.
  for (const entry of (options.extraVersions ?? process.env.BEVY_EXTRA_VERSIONS ?? "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const v = entry.slice(0, separator).trim();
    const dir = entry.slice(separator + 1).trim();
    if (!v || !dir || v === config.bevyVersion) continue;
    try {
      registry.registerSource(v, path.resolve(dir));
      await registry.get(v);
    } catch (err) {
      log(`multi-version: could not add ${v}: ${errorMessage(err)}`);
    }
  }

  const server = new McpServer(SERVER_INFO);

  const VERSION_NOTE = `Index built for Bevy ${config.bevyVersion ?? "UNKNOWN VERSION"}`;

  /** An unavailable requested version must never fall back to the active index. */
  type VersionResolution =
    | { known: true; index: BevyIndex; note: string }
    | { known: false; version: string };

  const indexedVersions = () => registry.versions().sort(cmpVersionForOrder);

  function unavailableVersion(version: string, symbol?: string): CallToolResult {
    return {
      isError: true,
      content: [{ type: "text", text: `Bevy ${version} is not indexed, so I cannot answer for that version.\n\n` +
        `Indexed versions: ${indexedVersions().join(", ") || "(none)"}.\n` +
        `Add it with \`bevy-mcp fetch-index ${version}\` or configure BEVY_EXTRA_VERSIONS.` }],
      structuredContent: { bevy_version: version, queried_version: version, version_indexed: false,
        indexed_versions: indexedVersions(), ...(symbol ? { symbol } : {}) },
    };
  }

  async function resolveVersion(version?: string | null): Promise<VersionResolution> {
    const active = config.bevyVersion;
    if (!version || version === active) {
      return { known: true, index, note: "" };
    }
    if (registry.has(version)) {
      try {
        const idx = await registry.get(version);
        return { known: true, index: idx, note: `\n> Showing **Bevy ${version}** (project is on ${active ?? "UNKNOWN"}).\n` };
      } catch (err) {
        log(`could not load Bevy ${version}: ${errorMessage(err)}`);
      }
    }
    return { known: false, version };
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

  const filtersOf = (args: { kind?: string; source?: string; module?: string; category?: string }) => ({
    kind: args.kind,
    source: args.source,
    module: args.module,
    category: args.category,
  });

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
      if (!res.known) return unavailableVersion(res.version);
      const results = hybridSearch(res.index, query, {
        limit,
        filters: filtersOf(rest),
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
      const filters: { kind: string; category?: string } = { kind: "code_example" };
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

    const all = findMigrations(index, from_version ?? null, to, { topic });
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
        const resolved = await resolveVersion(v);
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

  // Identity reads keep the corpus accessible while full-text search stays smaller.
  const resourceLayer = createResources({
    activeVersion: config.bevyVersion,
    versions: indexedVersions,
    resolveVersion: async (v) => {
      const resolved = await resolveVersion(v);
      return resolved.known ? resolved.index : null;
    },
  });

  server.registerResource(
    "bevy-index",
    resourceLayer.indexUri,
    {
      title: "Indexed Bevy versions",
      description:
        "Which Bevy versions this server can answer for, and how to construct a resource URI " +
        "for any item, type, crate or kind.",
      mimeType: "text/markdown",
    },
    async (uri) => resourceLayer.read(uri.href ?? uri.toString()),
  );

  // Completions use ResourceTemplate callbacks; discovery is paginated rather
  // than enumerating every item in resources/list.
  for (const t of resourceLayer.templates()) {
    const complete: NonNullable<ConstructorParameters<typeof ResourceTemplate>[1]["complete"]> = {};
    for (const raw of t.uriTemplate.match(/\{(\w+)\}/g) || []) {
      const name = raw.slice(1, -1);
      complete[name] = (value, context) =>
        resourceLayer.complete(t.uriTemplate, { argument: name, value, context });
    }

    server.registerResource(
      t.name,
      new ResourceTemplate(t.uriTemplate, { list: undefined, complete }),
      {
        title: t.title,
        description: t.description,
        mimeType: t.mimeType,
      },
      async (uri) => {
        const href = uri.href ?? uri.toString();
        // resources/read has no nextCursor field, so continuation lives in the URI.
        const cursor = uri.searchParams?.get("cursor") || undefined;
        const page = await resourceLayer.read(href, { cursor });
        if (!page.nextCursor) return page;
        const next = new URL(href);
        next.searchParams.set("cursor", page.nextCursor);
        page.contents = page.contents.map((content) => ({ ...content, uri: next.href }));
        return page;
      },
    );
  }

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
      if (!data) return { isError: true, content: [{ type: "text", text: "No version information is available." }] };
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

  return { server, index, registry, config, checkVersions, info: SERVER_INFO };
}
