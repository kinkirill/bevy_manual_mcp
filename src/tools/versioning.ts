/** Version-resolution guardrails shared by every tool. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "../types.js";
import { log } from "../config.js";
import { cmpVersion, type BevyIndex } from "../store.js";
import type { VersionRegistry } from "../registry.js";
import { errorMessage } from "../types.js";
import type { VersionResolution } from "./types.js";

const cmpVersionForOrder = cmpVersion;

export interface Versioning {
  resolveVersion: (version?: string | null) => Promise<VersionResolution>;
  indexedVersions: () => string[];
  unavailableVersion: (version: string, symbol?: string) => CallToolResult;
}

export function createVersioning(
  config: ResolvedConfig,
  registry: VersionRegistry,
  index: BevyIndex,
): Versioning {
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

  return { resolveVersion, indexedVersions, unavailableVersion };
}
