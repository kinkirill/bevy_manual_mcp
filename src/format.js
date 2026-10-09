/**
 * Response formatting.
 *
 * Design rules for tool output consumed by an LLM:
 *   - Lead with the answer (the signature), not with the prose.
 *   - Always state which Bevy version the result came from. An agent that
 *     cannot tell whether a signature is current will guess.
 *   - Return one compact block per hit and a source pointer, so the agent can
 *     ask again for more instead of receiving everything at once.
 *   - Prefer `structuredContent` (machine-readable) alongside a short text
 *     rendering, so clients can use either.
 */

const KIND_ICON = {
  rustdoc: { api: "⚙️" },
};

const SOURCE_LABEL = {
  rustdoc: "API",
  "bevy-examples": "example",
  "learn-examples": "example",
  website: "docs",
};

function iconFor(r) {
  if (r.source === "rustdoc") {
    return r.kind === "method" || r.kind === "fn" ? "🔧" : "⚙️";
  }
  if (r.kind === "code_example") return "🧩";
  if (r.kind === "migration_guide" || r.kind === "migration_entry")
    return "⚠️";
  if (r.kind === "release_notes") return "📦";
  return "📖";
}

function header(index) {
  const v = index.meta?.bevy_version;
  return v ? `Bevy ${v}` : "Bevy (version UNKNOWN — set BEVY_VERSION)";
}

/**
 * Compare one symbol across versions. This is the payoff of holding several
 * indexes: showing exactly how an API changed, rather than describing it.
 */
export function formatVersionDiff({ symbol, perVersion }) {
  const lines = [`# ${symbol} across Bevy versions`, ``];
  const sigs = new Set();

  for (const { version, record } of perVersion) {
    lines.push(`## Bevy ${version}`, ``);
    if (!record) {
      lines.push(`_Not present in the ${version} API index._`, ``);
      continue;
    }
    lines.push("```rust", record.signature || "(no signature recorded)", "```", ``);
    sigs.add(record.signature || "");
  }

  lines.push(`---`, ``);
  if (sigs.size > 1) {
    lines.push(
      `**This symbol's signature CHANGED across these versions** (${sigs.size} distinct ` +
        `forms). Any code written against one version may not compile against ` +
        `another. Call bevy_migration for the full list of changes.`,
    );
  } else {
    lines.push(
      `**This symbol's signature is identical across all indexed versions.** ` +
        `Upgrading within this range does not require changing this call site.`,
    );
  }
  return lines.join("\n");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n).trimEnd() + " …";
}

/** One compact rendering of a single record. */
export function formatRecord(r, { docsChars = 700 } = {}) {
  const parts = [];
  const icon = iconFor(r);
  const label = SOURCE_LABEL[r.source] || r.source;

  parts.push(`### ${icon} ${r.title || r.name}  _(${label}/${r.kind})_`);

  if (r.full_path) parts.push(`\`${r.full_path}\``);

  // Version provenance is the single most important line for an agent.
  const verBits = [];
  if (r.bevy_version) verBits.push(`indexed for Bevy ${r.bevy_version}`);
  if (r.to_version) verBits.push(`applies to ${r.from_version} → ${r.to_version}`);
  if (r.version && !r.to_version) verBits.push(`version ${r.version}`);
  if (r.pr) verBits.push(`PR #${r.pr}`);
  if (verBits.length) parts.push(`> ${verBits.join(" · ")}`);

  if (r.draft) {
    parts.push(
      `> ⚠️ This page is marked hidden/draft upstream — treat as incomplete.`,
    );
  }

  if (r.signature) {
    parts.push("```rust\n" + r.signature + "\n```");
  }

  // A type's documented `Default` value (captured from its `impl Default`).
  // This never appears in the type's own docs and is routinely guessed wrong.
  if (r.defaults) {
    parts.push(`**Default:** ${truncate(r.defaults, 300)}`);
  }

  if (r.breadcrumb?.length) {
    parts.push(`_Section: ${r.breadcrumb.join(" > ")}_`);
  } else if (r.heading) {
    parts.push(`_Section: ${r.heading}_`);
  }

  const docs = r.docs && r.docs.trim();
  if (r.kind === "code_example") {
    // Show the example's own description and its `setup`/`main` function, not a
    // blind first-N-chars slice. The point of an example is what it spawns (and
    // what it does *not* set); a 700-line file truncated at 3.5 KB can hide
    // exactly the `setup` body the reader needs.
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
function trimCode(text, max) {
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
 * Extract the `setup`/`main` function from an example source, braces balanced.
 * Returns null when the file has neither, so the caller can fall back to the
 * raw (truncated) code.
 */
function setupSnippet(code, max = 2800) {
  const lines = String(code).split("\n");
  // `setup*` / `spawn*` is where examples spawn things; `main` is usually just
  // the plugin list. Prefer the former, fall back to main.
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
    out.push(lines[i]);
    for (const ch of lines[i]) {
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

/** Full markdown rendering of a list of results. */
export function formatResults(index, results, query, opts = {}) {
  const label = opts.label || index.meta?.bevy_version;
  const lines = [`## Bevy ${label ?? "UNKNOWN"} — results for "${query}"`];

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

/** Machine-readable shape returned alongside the markdown. */
export function toStructured(results, index) {
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

/**
 * Renewal advisory: what the agent should actually do about a version change.
 * The patch/minor distinction is the point -- a patch release must not trigger
 * a rewrite of working code.
 */
export function formatUpgrade({ mine, newest, preview, bump, records }) {
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

export function formatStatus(index, config) {
  const m = index.meta || {};
  const s = index.stats || {};
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
  lines.push(`- cargo doc: ${m.doc_dir ?? "**not found** — run \`cargo doc\` in your Bevy project\`"}`);
  lines.push(`- bevy-website: ${m.website_dir ?? "**not found**"}`);
  lines.push(`- engine examples: ${m.examples_dir ?? "**not found** — clone the bevy repo for \`examples/\`"}`);
  if (m.built_at) lines.push("", `Built ${m.built_at} in ${m.build_ms}ms.`);
  return lines.join("\n");
}