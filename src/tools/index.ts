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

// Phase 1.1 — bevy_check_manifest
import { register as manifest } from "./manifest.js";
// Phase 1.2 — bevy_validate_systems
import { register as validateSystems } from "./validate_systems.js";
// Phase 1.3 — bevy_explain_error
import { register as explainError } from "./explain_error.js";
// Phase 3.1 — bevy_generate_plugin
import { register as generatePlugin } from "./generate_plugin.js";
// Phase 3.2 — bevy_perf_advisor
import { register as perfAdvisor } from "./perf_advisor.js";

export {
  search,
  api,
  examples,
  migration,
  apiDiff,
  checkVersion,
  indexedVersions,
  indexStatus,
  manifest,
  validateSystems,
  explainError,
  generatePlugin,
  perfAdvisor,
};

export function registerAll(server: McpServer, ctx: ToolContext): void {
  search(server, ctx);
  api(server, ctx);
  examples(server, ctx);
  migration(server, ctx);
  apiDiff(server, ctx);
  checkVersion(server, ctx);
  indexedVersions(server, ctx);
  indexStatus(server, ctx);
  manifest(server, ctx);
  validateSystems(server, ctx);
  explainError(server, ctx);
  generatePlugin(server, ctx);
  perfAdvisor(server, ctx);
}
