/** Shared tool context, filter schema and version-resolution types. */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "../types.js";
import type { BevyIndex } from "../store.js";
import type { VersionRegistry } from "../registry.js";
import type { createVersionChecker } from "../versions.js";

/** An unavailable requested version must never fall back to the active index. */
export type VersionResolution =
  | { known: true; index: BevyIndex; note: string }
  | { known: false; version: string };

export interface ToolContext {
  config: ResolvedConfig;
  registry: VersionRegistry;
  index: BevyIndex;
  checkVersions: ReturnType<typeof createVersionChecker>;
  resolveVersion: (version?: string | null) => Promise<VersionResolution>;
  indexedVersions: () => string[];
  unavailableVersion: (version: string, symbol?: string) => CallToolResult;
}

/** Shared filter schema so every tool narrows results the same way. */
export const filterShape = {
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

export function filtersOf(args: { kind?: string; source?: string; module?: string; category?: string }) {
  return {
    kind: args.kind,
    source: args.source,
    module: args.module,
    category: args.category,
  };
}
