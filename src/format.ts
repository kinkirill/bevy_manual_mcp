/**
 * Lead with signatures, version provenance and source pointers; return compact
 * text alongside structured results so clients can request more detail as needed.
 */

import type { BevyRecord, SearchHit, ResolvedConfig, VersionBump } from "./types.js";
import type { BevyIndex } from "./store.js";

const SOURCE_LABEL = {
  rustdoc: "API",
  "bevy-examples": "example",
  "learn-examples": "example",
  website: "docs",
};

function iconFor(r: BevyRecord): string {
  if (r.source === "rustdoc") {
    return r.kind === "method" || r.kind === "fn" ? "🔧" : "⚙️";
  }
  if (r.kind === "code_example") return "🧩";
  if (r.kind === "migration_guide" || r.kind === "migration_entry")
    return "⚠️";
  if (r.kind === "release_notes") return "📦";
  return "📖";
}

/** Summarize signature, location and availability changes for one symbol. */
export function formatVersionDiff({ symbol, perVersion }: {
  symbol: string; perVersion: { version: string; record: BevyRecord | null }[];
}): string {
  const lines = [`# ${symbol} across Bevy versions`, ``];
  const sigs = new Set();
  const paths = new Set();
  const missing = [];

  for (const { version, record } of perVersion) {
    lines.push(`## Bevy ${version}`, ``);
    if (!record) {
      lines.push(`_Not present in the ${version} API index._`, ``);
      missing.push(version);
      continue;
    }
    const path = record.full_path || record.module || "";
    if (path) {
      lines.push(`\`${path}\``, ``);
      paths.add(path);
    }
    lines.push("```rust", record.signature || "(no signature recorded)", "```", ``);
    sigs.add((record.signature || "").replace(/\s+/g, " ").trim());
  }

  lines.push(`---`, ``);
  if (sigs.size > 1) {
    lines.push(
      `**This symbol's signature CHANGED across these versions** (${sigs.size} distinct ` +
        `forms). Any code written against one version may not compile against ` +
        `another. Call bevy_migration for the full list of changes.`,
    );
  } else if (missing.length) {
    lines.push(
      `**The signature is identical where it exists, but the symbol is absent from ` +
        `${missing.join(", ")}.** Code using it there will not compile.`,
    );
  } else if (paths.size > 1) {
    lines.push(
      `**The signature is unchanged, but the item MOVED between modules.** A \`use\` of ` +
        `the old path will not resolve - update the import even though the call site ` +
        `itself still looks the same.`,
    );
  } else {
    lines.push(
      `**This symbol's signature and location are identical across these versions.** ` +
        `Upgrading within this range does not require changing this call site.`,
    );
  }
  return lines.join("\n");
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n).trimEnd() + " …";
}

interface FormatOptions {
  docsChars?: number;
  exampleChars?: number;
  exampleLimit?: number;
  label?: string | null;
}

export function formatRecord(r: BevyRecord, { docsChars = 700, exampleChars = 1200, exampleLimit = 2 }: FormatOptions = {}): string {
  const parts = [];
  const icon = iconFor(r);
  const label = SOURCE_LABEL[r.source] || r.source;

  parts.push(`### ${icon} ${r.title || r.name}  _(${label}/${r.kind})_`);

  if (r.full_path) parts.push(`\`${r.full_path}\``);

  const verBits = [];
  if (r.bevy_version) verBits.push(`indexed for Bevy ${r.bevy_version}`);
  if (r.to_version) verBits.push(`applies to ${r.from_version} → ${r.to_version}`);
  if (r.version && !r.to_version) verBits.push(`version ${r.version}`);
  if (r.pr) verBits.push(`PR #${r.pr}`);
  if (verBits.length) parts.push(`> ${verBits.join(" · ")}`);

  if (r.draft) {
    parts.push(
      `> ⚠️ This page is marked hidden/draft upstream - treat as incomplete.`,
    );
  }

  if (r.signature) {
    parts.push("```rust\n" + r.signature + "\n```");
  }

  // Defaults are documented on the trait impl rather than in the type's docblock.
  if (r.defaults) {
    parts.push(`**Default:** ${truncate(r.defaults, 300)}`);
  }

  if (r.breadcrumb?.length) {
    parts.push(`_Section: ${r.breadcrumb.join(" > ")}_`);
  } else if (r.heading) {
    parts.push(`_Section: ${r.heading}_`);
  }

  if (r.examples?.length) {
    const shown = r.examples.slice(0, exampleLimit);
    for (const ex of shown) {
      if (!ex.code.trim()) continue;
      const note = ex.compile_fail
        ? "> This example does **not** compile - it demonstrates a mistake.\n"
        : ex.ignored
          ? "> Shown for illustration; not a compiling example.\n"
          : null;
      if (note) parts.push(note.trim());
      if (ex.source_file) {
        parts.push(`_Example scraped from \`${ex.source_file}\`_`);
      }
      parts.push("```rust\n" + trimCode(ex.code, exampleChars) + "\n```");
    }
    if (r.examples.length > shown.length) {
      parts.push(
        `_${r.examples.length - shown.length} further example(s) not shown._`,
      );
    }
  }

  const docs = r.docs && r.docs.trim();
  if (r.kind === "code_example") {
    // Prefer setup code so truncation does not hide the example's entity creation.
    const desc = (r.description || "").trim();
    if (desc) parts.push(truncate(desc, 600));
    const code = r.code || docs || "";
    if (code) {
      parts.push(
        "```rust\n" + trimCode(setupSnippet(code, 2800) || code, 2800) + "\n```",
      );
    }
    if (r.required_features?.length) {
      parts.push(
        `_Example features: ${r.required_features.slice(0, 12).join(", ")}_`,
      );
    }
  } else if (docs && docsChars > 0) {
    parts.push(truncate(docs, docsChars));
  }

  const loc = [];
  if (r.file) {
    loc.push(
      r.source === "rustdoc"
        ? `file: ${r.file}`
        : `file: ${r.file}${r.line_start ? `:${r.line_start}` : ""}`,
    );
  }
  if (loc.length) parts.push("`" + loc.join(" ") + "`");

  return parts.join("\n\n");
}

/** Keep code fences balanced when slicing an example. */
function trimCode(text: string, max: number): string {
  let t = text;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lines = cut.split("\n");
  // Drop a trailing partial line rather than cutting mid-statement.
  lines.pop();
  let out = lines.join("\n");
  const fences = (out.match(/```/g) || []).length;
  if (fences % 2 === 1) out += "\n```";
  return out;
}

/**
 * Extract a setup/spawn/main function with balanced braces, or return null so
 * the caller can fall back to the raw code.
 */
function setupSnippet(code: string, max = 2800): string | null {
  const lines = String(code).split("\n");
  // setup/spawn functions contain the scene; main usually only configures plugins.
  const patterns = [
    /^\s*fn\s+setup\w*\s*\(/,
    /^\s*fn\s+spawn\w*\s*\(/,
    /^\s*fn\s+main\b/,
  ];
  let start = -1;
  for (const re of patterns) {
    start = lines.findIndex((l) => re.test(l));
    if (start !== -1) break;
  }
  if (start === -1) return null;
  const out = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) break;
    if (out.join("\n").length > max) break;
  }
  return out.join("\n");
}

export function formatResults(index: BevyIndex, results: SearchHit[], query: string, opts: FormatOptions = {}): string {
  const label = opts.label || index.meta?.bevy_version;
  const lines = [`## Bevy ${label ?? "UNKNOWN"} - results for "${query}"`];

  if (!results.length) {
    lines.push(
      "",
      "No matches. Try:",
      "- an exact symbol name (`App::add_systems`, `Query`, `Commands::spawn`)",
      "- a shorter, single-concept keyword (`schedules`, `ui`, `gizmos`)",
      "- `bevy_index_status` to check which sources are actually indexed.",
    );
    return lines.join("\n");
  }

  lines.push("", `_${results.length} match(es). Sources: API docs, Bevy Book, migration guides, examples._`, "");

  for (const { record } of results) {
    lines.push(formatRecord(record, opts));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

export function toStructured(results: SearchHit[], index: BevyIndex) {
  return {
    bevy_version: index.meta?.bevy_version ?? null,
    version_source: index.meta?.version_source ?? null,
    count: results.length,
    results: results.map(({ record: r, score }) => ({
      source: r.source,
      kind: r.kind,
      name: r.name,
      full_path: r.full_path,
      signature: r.signature || undefined,
      defaults: r.defaults || undefined,
      heading: r.heading || undefined,
      breadcrumb: r.breadcrumb?.length ? r.breadcrumb : undefined,
      doc_excerpt: r.docs ? truncate(r.docs.replace(/\s+/g, " "), 300) : undefined,
      file: r.file || undefined,
      line_start: r.line_start || undefined,
      to_version: r.to_version || undefined,
      from_version: r.from_version || undefined,
      pr: r.pr || undefined,
      draft: r.draft || undefined,
      score: Math.round(score),
    })),
  };
}

/** Distinguish patch notices from upgrades that require API migration. */
export function formatUpgrade({ mine, newest, preview, bump, records }: {
  mine: string | null; newest: string; preview?: string | null; bump: VersionBump; records?: number;
}): string {
  const lines = [`# bevy-mcp update notice`, ``];

  lines.push(`- **Indexed for:** ${mine ?? "UNKNOWN"}`);
  lines.push(`- **Newest stable:** ${newest}`);
  if (preview && preview !== newest) lines.push(`- **Pre-release:** ${preview}`);
  if (records) lines.push(`- **Your code still referencing:** ${records} symbols in ${mine}`);

  lines.push(``, `## What this means`, ``, bump.label, ``);

  if (bump.level === "none") {
    lines.push(`Your index is current. No action needed.`);
  } else if (!bump.breaksApi) {
    lines.push(
      `**No API changes.** Patch releases carry bug fixes only. Your code is ` +
        `still correct against ${mine}; there is nothing to migrate and no reason ` +
        `to rewrite it.`,
    );
  } else {
    lines.push(
      `**Breaking API changes.** Before changing any code, call ` +
        `\`bevy_migration\` with from_version=${mine}, to_version=${newest} to get the ` +
        `concrete list. Do not guess at the new API.`,
    );
  }
  return lines.join("\n");
}

export function formatStatus(index: BevyIndex, config: ResolvedConfig): string {
  const m = index.meta ?? { bevy_version: null };
  const s = index.stats;
  const mismatch =
    config?.docVersion &&
    config?.bevyVersion &&
    config.docVersion.split("-")[0] !== config.bevyVersion.split("-")[0];

  const lines = [
    "# bevy-mcp index status",
    "",
    `- **Bevy version:** ${m.bevy_version ?? "UNKNOWN"}`,
    `- **Detected from:** ${m.version_source ?? config?.versionSource ?? "n/a"}`,
    `- **Host project:** ${config?.projectRoot ?? "n/a"}`,
    `- **Records:** ${s.total ?? 0} (${m.symbols ?? 0} exact symbols)`,
  ];

  if (mismatch) {
    lines.push(
      "",
      "## ❌ VERSION MISMATCH",
      "",
      `The rustdoc on disk was built from **bevy ${config.docVersion}**, but the project ` +
        `resolved to **bevy ${config.bevyVersion}**. Results describe ${config.docVersion} ` +
        `but are labelled ${config.bevyVersion}, so signatures may be wrong.`,
      "",
      `Fix by pointing BEVY_DOC_DIR at matching docs, or set BEVY_VERSION=${config.docVersion}.`,
    );
  } else if (config?.docVersion) {
    lines.push(`- **Docs built from:** bevy ${config.docVersion} (matches)`);
  }

  lines.push("", "## Sources", "");

  for (const [k, v] of Object.entries(s.by_source || {})) {
    lines.push(`- \`${k}\`: ${v}`);
  }
  lines.push("", "## By kind", "");
  for (const [k, v] of Object.entries(s.by_kind || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${k}\`: ${v}`);
  }

  lines.push("", "## Paths", "");
  lines.push(`- cargo doc: ${m.doc_dir ?? "**not found** - run \`cargo doc\` in your Bevy project\`"}`);
  lines.push(`- bevy-website: ${m.website_dir ?? "**not found**"}`);
  lines.push(`- engine examples: ${m.examples_dir ?? "**not found** - clone the bevy repo for \`examples/\`"}`);
  if (m.built_at) lines.push("", `Built ${m.built_at} in ${m.build_ms}ms.`);
  return lines.join("\n");
}
