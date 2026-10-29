/** `bevy_validate_systems` tool — lint Bevy system signatures for access rule violations. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeSystem, matchingClose, stripRustTrivia, stripParamAttrs } from "../analysis/rust-fn.js";
import { checkConflicts, type Finding } from "../analysis/conflicts.js";
import { formatResult } from "../analysis/report.js";
import type { ToolContext, VersionResolution } from "./types.js";

/**
 * Extract real `fn` signatures. Comments and string literals are blanked first,
 * so a `fn` mentioned in either does not become a phantom system.
 */
function extractFnSignatures(code: string): string[] {
  const cleaned = stripRustTrivia(code);
  const signatures: string[] = [];
  const pattern = /\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^<>()]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned))) {
    const open = cleaned.indexOf("(", match.index);
    if (open === -1) continue;
    const close = matchingClose(cleaned, open);
    if (close === -1) continue;
    signatures.push(cleaned.slice(match.index, close + 1));
  }
  return signatures;
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
        `B0002 (Res/ResMut conflicts), and related patterns. Query component access is tracked ` +
        `per tuple member, so \`Query<(&Transform, &mut Velocity)>\` borrows only \`Velocity\` mutably. ` +
        `This is a syntax-level linter for Bevy's access rules, not a Rust type checker: ` +
        `"no conflicts detected" never means the code compiles. Constructs outside the supported ` +
        `subset are reported in \`unanalyzed\`.`,
      inputSchema: {
        code: z
          .string()
          .describe("One or more fn items to validate (e.g., 'fn move(q: Query<&Transform>, mut r: ResMut<Assets<Mesh>>) {}')"),
      },
    },
    async ({ code }) => {
      const res: VersionResolution = await resolveVersion();
      if (!res.known) return unavailableVersion(config.bevyVersion!);

      const signatures = extractFnSignatures(code);
      if (signatures.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "No fn items found in the provided code." }],
        };
      }

      const findings: Finding[] = [];
      const unanalyzed: string[] = [];
      let systemsChecked = 0;

      for (const signature of signatures) {
        const analysis = analyzeSystem(signature);
        if (!analysis) { unanalyzed.push(signature.trim()); continue; }
        systemsChecked++;
        analysis.params.forEach((param, index) => {
          if (param.kind === "Query") {
            for (const raw of param.unparsed ?? []) unanalyzed.push(raw);
          } else if (param.kind === "Other") {
            unanalyzed.push(stripParamAttrs(analysis.rawParams[index] ?? "").trim());
          }
        });
        findings.push(...checkConflicts(analysis.params));
      }

      return {
        content: [{ type: "text", text: formatResult(findings, systemsChecked) }],
        structuredContent: {
          bevy_version: config.bevyVersion,
          systems_checked: systemsChecked,
          findings_count: findings.length,
          analysis_complete: unanalyzed.length === 0,
          unanalyzed,
          findings: findings.map((finding) => ({
            rule: finding.rule,
            severity: finding.severity,
            resource_type: finding.resourceType,
            param_a: finding.paramA,
            param_b: finding.paramB,
            description: finding.description,
            error_code: finding.errorCode,
          })),
        },
      };
    },
  );
}
