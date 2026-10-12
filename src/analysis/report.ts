/** Formatting for system validation findings. */
import type { Finding } from "./conflicts.js";

/** Format a clean validation result. */
export function formatResult(findings: Finding[], systemsChecked: number): string {
  if (!findings.length) {
    return `## System Validation Result\n\n✅ **No conflicts detected**\n\n` +
      `Checked ${systemsChecked} system(s). All access patterns are compatible.\n\n` +
      `Note: This tool checks Bevy access rules only — it does not verify types, lifetimes, trait bounds, or logic.`;
  }

  let output = `## System Validation Result\n\n⚠️ **${findings.length} conflict(s) found**\n\n`;

  for (const f of findings) {
    output += `### 🔴 ${f.severity.toUpperCase()} — Rule ${f.rule}${f.errorCode ? ` (${f.errorCode})` : ""}\n\n`;
    output += `${f.description}\n`;
    if (f.paramA || f.resourceType) {
      const params = [f.paramA, f.paramB].filter(Boolean).join(" + ");
      output += `\n**Parameters**: ${params}\n`;
    }
  }

  return output;
}
