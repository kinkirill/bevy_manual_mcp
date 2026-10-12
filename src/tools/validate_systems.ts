/** `bevy_validate_systems` tool — lint Bevy system signatures for access rule violations. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeSystem } from "../analysis/rust-fn.js";
import { checkConflicts, type Finding } from "../analysis/conflicts.js";
import { formatResult } from "../analysis/report.js";
import type { ToolContext, VersionResolution } from "./types.js";

/** Extract all fn items from the code block. */
function extractFnItems(code: string): string[] {
  const items: string[] = [];
  let start = 0;
  while (true) {
    const idx = code.indexOf("fn", start);
    if (idx === -1) break;

    // Make sure it's not part of a word
    if (idx > 0 && /[a-zA-Z_]/.test(code[idx - 1]!)) {
      start = idx + 2;
      continue;
    }

    // Find the parameter list opening
    const parenIdx = code.indexOf("(", idx);
    if (parenIdx === -1) break;

    // Find matching closing paren (handle nested parens/brackets)
    let depth = 0;
    let endIdx: number | null = null;
    for (let i = parenIdx; i < code.length; i++) {
      const ch = code[i]!;
      if (ch === "(" || ch === "<" || ch === "[") depth++;
      if (ch === ")" || ch === ">" || ch === "]") depth--;

      if (depth === 0 && ch === ")") {
        endIdx = i + 1;
        break;
      }
    }

    if (endIdx === null) break;

    // Extract the full fn item (up to the next semicolon or closing brace)
    let bodyEnd = code.indexOf("{", endIdx);
    if (bodyEnd === -1 || bodyEnd > 500) {
      // No body found, just use the signature
      items.push(code.slice(idx, endIdx).trim());
    } else {
      const semiOrBrace = findClosingParen(code, endIdx);
      items.push(code.slice(idx, semiOrBrace ?? code.length).trim());
    }

    start = endIdx + 1;
  }

  return items;
}

/** Find the closing paren for a fn signature (handles nested <> etc). */
function findClosingParen(code: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    if (ch === ")" || ch === ">" || ch === "]") depth--;

    if (depth === 0 && ch === ")") return i + 1;
  }
  return code.length;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const { config, resolveVersion, unavailableVersion } = ctx;

  server.registerTool(
    "bevy_validate_systems",
    {
      title: "Validate Bevy system signatures for access rule violations",
      description:
        `Lints one or more fn items against Bevy's access rules. Catches the class of bug that ` +
        `compiles cleanly but panics on the first frame — B0001 (conflicting Query refs), ` +
        `B0002 (Res/ResMut conflicts), and related patterns. Returns findings with severity, ` +
        `the conflicting parameters, rule ID, error code, and suggested fix from the pinned version's rustdoc.`,
      inputSchema: {
        code: z
          .string()
          .describe("One or more fn items to validate (e.g., 'fn move(q: Query<&Transform>, mut r: ResMut<Assets<Mesh>>) {}')"),
        context: z
          .string()
          .optional()
          .describe("Extra known-enabled features for context."),
      },
    },
    async ({ code, context }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);

      // Extract fn items from the code block
      const fnItems = extractFnItems(code);
      if (fnItems.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "No fn items found in the provided code." }],
        };
      }

      let allFindings: Finding[] = [];

      for (const item of fnItems) {
        const analysis = analyzeSystem(item);
        if (!analysis || !analysis.params.length) continue;

        // Run conflict rules
        const findings = checkConflicts(analysis.params);
        allFindings.push(...findings);
      }

      return {
        content: [{ type: "text", text: formatResult(allFindings, fnItems.length) }],
        structuredContent: {
          bevy_version: config.bevyVersion,
          systems_checked: fnItems.length,
          findings_count: allFindings.length,
          findings: allFindings.map((f) => ({
            rule: f.rule,
            severity: f.severity,
            resource_type: f.resourceType,
            description: f.description,
            error_code: f.errorCode,
          })),
        },
      };
    },
  );
}
