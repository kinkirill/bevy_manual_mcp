/** Tool registry. Each module exports `register(server, ctx)`. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types.js";
import { register as search } from "./search.js";
import { register as api } from "./api.js";
import { register as examples } from "./examples.js";
import { register as migration } from "./migration.js";
import { register as apiDiff } from "./api_diff.js";
import { register as checkVersion } from "./check_version.js";
import { register as indexedVersions } from "./indexed_versions.js";
import { register as indexStatus } from "./index_status.js";

export { search, api, examples, migration, apiDiff, checkVersion, indexedVersions, indexStatus };

export function registerAll(server: McpServer, ctx: ToolContext): void {
  search(server, ctx);
  api(server, ctx);
  examples(server, ctx);
  migration(server, ctx);
  apiDiff(server, ctx);
  checkVersion(server, ctx);
  indexedVersions(server, ctx);
  indexStatus(server, ctx);
}
