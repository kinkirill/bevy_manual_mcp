/** `bevy_index_status` tool. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatStatus } from "../format.js";
import type { ToolContext } from "./types.js";

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, index } = ctx;

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
        meta_dir: config.metaDir,
        errors_dir: config.errorsDir,
        stats: index.stats,
        symbols: index.meta?.symbols,
        built_at: index.meta?.built_at,
        has_api_index: (index.stats.by_source.rustdoc ?? 0) > 0,
      },
    }),
  );
}
