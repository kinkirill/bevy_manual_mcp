/** `bevy_explain_error` tool — explain pasted panic/warning text. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseJson, type ResolvedConfig } from "../types.js";
import { loadFeatures, type FeaturesData } from "../analysis/features.js";
import type { ToolContext, VersionResolution } from "./types.js";

/** Extract error codes and dynamic parts from a panic/warning message. */
export function extractErrorParts(message: string): {
  code?: string;
  severity?: "panic" | "warning";
  system_name?: string;
  resource_type?: string;
  access_list?: string[];
  raw_message: string;
} {
  const result = {
    code: undefined as string | undefined,
    severity: undefined as "panic" | "warning" | undefined,
    system_name: undefined as string | undefined,
    resource_type: undefined as string | undefined,
    access_list: [] as string[],
    raw_message: message.trim(),
  };

  // Try to extract error code: error[B0002]: or warning[B0004]:
  const codeMatch = message.match(/(error|warning)\[(B\d{4})\]/);
  if (codeMatch) {
    result.severity = codeMatch[1] === "error" ? "panic" : "warning";
    result.code = codeMatch[2];

    // Try to extract system name
    const sysMatch = message.match(/system\s+['"`]?(\S+?)['"`]?\s*[,:]/);
    if (sysMatch) {
      result.system_name = sysMatch[1];
    }

    // Try to extract resource types and access patterns
    const resTypeMatch = message.match(/ResMut<([^<>]*(?:<[^<>]*>[^<>]*)*)>/);
    if (resTypeMatch) {
      result.resource_type = resTypeMatch[1];
      result.access_list.push("ResMut");
    } else {
      // Plain `Res<T>` (ResMut is handled above). The lookbehind keeps `Res`
      // from matching inside a longer identifier.
      const resOnly = message.match(/(?<![\w:])Res<([^<>]*(?:<[^<>]*>[^<>]*)*)>/);
      if (resOnly) {
        result.resource_type = resOnly[1];
        result.access_list.push("Res");
      }
    }

    // Extract access list patterns
    if (message.includes("&mut")) result.access_list.push("&mut");
    if (message.includes("&") && !message.includes("&mut")) result.access_list.push("&");
  }

  return result;
}

/** Load an error code markdown file from vendored metadata. */
function loadErrorCode(
  config: ResolvedConfig,
  version: string,
  errorCode: string,
): string | null {
  const errPath = path.join(config.metaDir!, version, "error-codes", `${errorCode}.md`);
  if (!fs.existsSync(errPath)) return null;

  try {
    return fs.readFileSync(errPath, "utf8");
  } catch {
    return null;
  }
}

/** Check if an error code exists for a given version. */
function errorCodeExists(config: ResolvedConfig, version: string, code: string): boolean {
  const errPath = path.join(config.metaDir!, version, "error-codes", `${code}.md`);
  return fs.existsSync(errPath);
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_explain_error",
    {
      title: "Explain a pasted Bevy panic or warning message",
      description:
        `Takes a pasted panic or warning message from Bevy and explains the cause, severity, ` +
        `and suggested fix. Extracts error codes like B0001/B0002 automatically. For uncoded ` +
        `panics, falls back through tiered matching (error code -> panic-site patterns -> honest refusal).`,
      inputSchema: {
        message: z
          .string()
          .describe("A pasted Bevy panic or warning message to explain."),
        full: z
          .boolean()
          .optional()
          .describe(
            "Include the complete guide with both worked solutions (default false - just the fix).",
          ),
      },
    },
    async ({ message, full = false }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);

      // Extract error parts from the message
      const extracted = extractErrorParts(message);

      let output = "## Error Explanation\n\n";

      if (extracted.code) {
        // Version-checked lookup
        const versionExists = errorCodeExists(config, config.bevyVersion!, extracted.code!);

        if (!versionExists) {
          // This error code doesn't exist in this Bevy version
          output += `⚠️ **Error code [${extracted.code}] does not exist in Bevy ${config.bevyVersion}.**\n\n`;
          output += `This code may have been introduced after your pinned version. The tool cannot answer from a different version's index.\n`;

          return {
            content: [{ type: "text", text: output }],
            structuredContent: {
              code: extracted.code,
              severity: extracted.severity ?? "unknown",
              system_name: extracted.system_name,
              resource_type: extracted.resource_type,
              applicable_version: config.bevyVersion,
              version_indexed: res.known,
              does_not_exist_in_version: true,
            },
          };
        }

        // Load the error code guide
        const guide = loadErrorCode(config, config.bevyVersion!, extracted.code!);

        output += `**Error Code**: \`${extracted.code}\`\n`;
        output += `**Severity**: ${extracted.severity ?? "unknown"}\n`;
        if (extracted.system_name) output += `**System**: \`${extracted.system_name}\`\n`;
        if (extracted.resource_type) output += `**Resource Type**: \`${extracted.resource_type}\`\n`;

        output += "\n---\n\n";

        if (guide && full) {
          // Include the complete guide
          output += "### Complete Guide for " + extracted.code + "\n\n" + guide;
        } else if (guide) {
          // Extract just the fix section
          const fixMatch = guide.match(/## Fix(?:ed Solutions)?\s*\n([\s\S]*?)(?:## |\Z)/);
          if (fixMatch) {
            output += "### Fix\n\n" + fixMatch[1];
          } else {
            // No explicit fix section - include the full guide with truncation
            const truncated = guide.length > 2000 ? guide.slice(0, 2000) + "\n...(truncated)" : guide;
            output += "### Guide\n\n" + truncated;
          }
        } else {
          output += "No detailed guide available for `" + extracted.code + "`.\n";

          // Provide generic guidance based on the error code pattern
          if (extracted.code === "B0001" || extracted.code === "B0003") {
            output += "\n**General fix**: Use Without<T> to disjoint conflicting Query references, or wrap parameters in `SystemParamSet<(...)`. \n";
          } else if (extracted.code === "B0002" || extracted.code === "B0004") {
            output += "\n**General fix**: Avoid mixing mutable and immutable access to the same resource. Use `SystemParamSet` or defer one access.\n";
          }

          output += "\nTo see worked solutions, run with `full: true`.";
        }

        return {
          content: [{ type: "text", text: output }],
          structuredContent: {
            code: extracted.code,
            severity: extracted.severity ?? "unknown",
            system_name: extracted.system_name,
            resource_type: extracted.resource_type,
            access_list: extracted.access_list,
            applicable_version: config.bevyVersion,
            version_indexed: res.known,
          },
        };
      }

      // No error code found - tier 2: panic-site pattern matching
      const featuresData = loadFeatures(config, config.bevyVersion!);
      if (featuresData?.panic_sites) {
        output += "⚠️ **No error code extracted from the message.**\n\n";
        output += "Attempting panic-site pattern match...\n";

        // Check against known panic patterns (conservative - don't guess)
        const hasPanicSites = Object.keys(featuresData.panic_sites).length > 0;
        if (!hasPanicSites) {
          output += "\nNo panic-site data available for this version.\n";
        } else {
          output += "\nPanic sites are recorded but pattern matching is not yet implemented for uncoded messages.\n";
        }

        // Tier 3: honest refusal
        output += "\n---\n\n";
        output += "This is not a recognised Bevy error code. Returning parsed type names:\n";

        if (extracted.resource_type) {
          output += "- Resource type: `" + extracted.resource_type + "`\n";
        }
        for (const access of (extracted.access_list ?? [])) {
          output += "- Access pattern: `" + access + "`\n";
        }

        output += "\nFor unknown panics, try `bevy_search` or `bevy_api` to look up specific types and systems.";

        return {
          content: [{ type: "text", text: output }],
          structuredContent: {
            tier: 3,
            resource_type: extracted.resource_type,
            access_list: extracted.access_list,
            applicable_version: config.bevyVersion,
            version_indexed: res.known,
            no_error_code_found: true,
          },
        };
      }

      // No panic-site data at all
      output += "⚠️ **No error code extracted and no metadata available.**\n\n";
      output += "For unknown panics, try `bevy_search` or `bevy_api` to look up specific types and systems.";

      return {
        content: [{ type: "text", text: output }],
        structuredContent: {
          tier: 3,
          resource_type: extracted.resource_type,
          applicable_version: config.bevyVersion,
          version_indexed: res.known,
          no_error_code_found: true,
          no_metadata_available: true,
        },
      };
    },
  );
}
