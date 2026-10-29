//! Markdown report for system validation.
//!
//! Ported from `src/analysis/report.ts`, with per-system sections (the old
//! formatter lost which system a finding belonged to) and an explicit
//! incomplete-analysis section.

use std::fmt::Write;

use super::systems::Analysis;

/// Render the analysis. `version` is the corpus version, when one is known.
pub fn format(analysis: &Analysis, version: Option<&str>) -> String {
    let mut out = String::new();
    match version {
        Some(version) => {
            let _ = writeln!(out, "# System validation — Bevy {version}\n");
        }
        None => out.push_str("# System validation\n\n"),
    }

    let systems = analysis.systems.len();
    let findings = analysis.findings.len();
    if findings == 0 {
        let _ = writeln!(
            out,
            "✅ **No conflicts detected** in {systems} system(s).\n"
        );
    } else {
        let _ = writeln!(
            out,
            "⚠️ **{findings} conflict(s) found** across {systems} system(s).\n"
        );
    }

    if !analysis.findings.is_empty() {
        out.push_str("## Findings\n\n");
        for finding in &analysis.findings {
            let code = finding
                .error_code
                .map(|code| format!(" ({code})"))
                .unwrap_or_default();
            let _ = writeln!(
                out,
                "### 🔴 {} — rule {}{code} in `{}`\n",
                finding.severity.to_uppercase(),
                finding.rule,
                finding.system
            );
            let _ = writeln!(out, "{}\n", finding.description);
            let parameters = match &finding.param_b {
                Some(second) => format!("`{}` + `{second}`", finding.param_a),
                None => format!("`{}`", finding.param_a),
            };
            let _ = writeln!(out, "**Parameters**: {parameters}\n");
        }
    }

    if systems > 0 {
        out.push_str("## Systems\n\n");
        for system in &analysis.systems {
            let params = if system.params.is_empty() {
                "(none)".to_string()
            } else {
                system
                    .params
                    .iter()
                    .map(|param| format!("`{param}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let _ = writeln!(out, "- `{}` — {params}", system.name);

            for access in &system.accesses {
                let _ = writeln!(
                    out,
                    "  - {} `{}` ({})",
                    if access.mutable { "write" } else { "read" },
                    access.target,
                    access.kind
                );
            }
        }
        out.push('\n');
    }

    if !analysis.unsupported.is_empty() {
        out.push_str("## Analysis incomplete\n\n");
        out.push_str(
            "These constructs were not understood, so conflicts involving them may be missing:\n\n",
        );
        for note in &analysis.unsupported {
            let _ = writeln!(out, "- {note}");
        }
        out.push('\n');
    }

    out.push_str(
        "> Syntax-level analysis only: this parses `fn` items with `syn`; it does not \
type-check, resolve aliases, or prove lifetimes and trait bounds. B0001/B0002 are \
Bevy *runtime* panics, not compile errors.\n",
    );
    out
}
