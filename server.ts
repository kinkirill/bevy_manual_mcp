#!/usr/bin/env node
/** Stdio diagnostics must use stderr to preserve the JSON-RPC transport. */

import fs from "node:fs";
import path from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveConfig, log, PACKAGE_ROOT } from "./src/config.js";
import { BevyIndex } from "./src/store.js";
import { VersionRegistry } from "./src/registry.js";
import { createResources } from "./src/resources_impl.js";
import { apiUri } from "./src/resources.js";
import { createVersionChecker } from "./src/versions.js";
import { errorMessage } from "./src/types.js";
import { registerAll } from "./src/tools/index.js";
import { createVersioning } from "./src/tools/versioning.js";
import type { ToolContext } from "./src/tools/types.js";

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
export async function createBevyServer(config = resolveConfig(), options: ServerOptions = {}) {

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

  const versioning = createVersioning(config, registry, index);
  const ctx: ToolContext = {
    config,
    registry,
    index,
    checkVersions,
    resolveVersion: versioning.resolveVersion,
    indexedVersions: versioning.indexedVersions,
    unavailableVersion: versioning.unavailableVersion,
  };

  registerAll(server, ctx);

  const resourceLayer = createResources({
    activeVersion: config.bevyVersion,
    versions: versioning.indexedVersions,
    resolveVersion: async (v) => {
      const resolved = await versioning.resolveVersion(v);
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

  return { server, index, registry, config, checkVersions, info: SERVER_INFO };
}
