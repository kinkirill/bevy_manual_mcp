/**
 * Markdown ingester for a bevy-website checkout.
 *
 * The website is the richest prose source available offline:
 *   content/learn/book/**                  conceptual guide ("The Bevy Book")
 *   content/learn/migration-guides/**      consolidated X-to-Y migration guides
 *   content/learn/quick-start/**           task-oriented tutorials
 *   release-content/<ver>/migration-guides/**   per-PR breaking-change notes
 *   release-content/<ver>/release-notes/**  curated release notes
 *
 * Long chapters are split on headings so a search hit points at the right
 * section instead of the first 1500 characters of the file.
 */

import fs from "node:fs";
import path from "node:path";

/** Strip a Zola/TOML front matter block and parse the few keys we care about. */
function splitFrontMatter(text) {
  const m = text.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const fm = m[1];
  const title = fm.match(/^\s*title\s*=\s*"([^"]*)"/m);
  if (title) meta.title = title[1];
  const weight = fm.match(/^\s*weight\s*=\s*(\d+)/m);
  if (weight) meta.weight = Number(weight[1]);
  const status = fm.match(/^\s*status\s*=\s*'([^']*)'/m);
  if (status) meta.status = status[1];
  const longTitle = fm.match(/^\s*long_title\s*=\s*"([^"]*)"/m);
  if (longTitle) meta.long_title = longTitle[1];
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n/, "") };
}

function walkMarkdown(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "target") continue;
      walkMarkdown(full, out);
    } else if (e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Classify a file by its path inside the website repo. */
function classify(rel) {
  const migration = rel.match(
    /^content\/learn\/migration-guides\/(\d+\.\d+)-to-(\d+\.\d+)\.md$/,
  );
  if (migration) {
    return {
      kind: "migration_guide",
      title: `Migration guide ${migration[1]} -> ${migration[2]}`,
      from_version: migration[1],
      to_version: migration[2],
    };
  }
  if (rel.startsWith("content/learn/migration-guides/")) {
    return { kind: "migration_guide", title: "Migration guides (index)" };
  }

  const relMig = rel.match(
    /^release-content\/(\d+\.\d+)\/migration-guides\/(?:(\d+)_)?(.*)\.md$/,
  );
  if (relMig) {
    const slug = relMig[3].replace(/_/g, " ");
    return {
      kind: "migration_entry",
      title: slug,
      version: relMig[1],
      pr: relMig[2] ? Number(relMig[2]) : null,
    };
  }

  const relNotes = rel.match(/^release-content\/(\d+\.\d+)\/release-notes\/(.*)\.md$/);
  if (relNotes) {
    return {
      kind: "release_notes",
      title: relNotes[2].replace(/_/g, " "),
      version: relNotes[1],
    };
  }

  if (rel.startsWith("content/learn/book/")) {
    return { kind: "book", title: null };
  }
  if (rel.startsWith("content/learn/quick-start/")) {
    return { kind: "tutorial", title: null };
  }
  if (rel.startsWith("content/learn/advanced-examples/")) {
    return { kind: "tutorial", title: null };
  }
  if (rel.startsWith("content/learn/")) {
    return { kind: "guide", title: null };
  }
  if (rel.startsWith("content/faq")) {
    return { kind: "faq", title: "FAQ" };
  }
  if (rel.startsWith("content/news/")) {
    return { kind: "news", title: null };
  }
  // Non-technical sections: present in the checkout but never useful for
  // writing Bevy code. Tagged so the indexer can drop them by weight 0.
  if (rel.startsWith("content/foundation")) {
    return { kind: "foundation", title: null };
  }
  if (rel.startsWith("content/donate")) {
    return { kind: "donate", title: null };
  }
  if (rel.startsWith("content/sponsorship-pledge")) {
    return { kind: "sponsorship", title: null };
  }
  return { kind: "doc", title: null };
}

/**
 * Split a document into heading-scoped chunks. Keeps a breadcrumb so a result
 * can be cited precisely, e.g. "The Game Loop > Scheduling > System Ordering".
 */
function chunkByHeadings(body, { maxChars = 4000 } = {}) {
  const lines = body.split(/\r?\n/);
  const chunks = [];
  const stack = [];

  let heading = null;
  let headingLine = 0;
  let buf = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length >= 40) {
      const breadcrumb = stack
        .map((h) => h.replace(/^#+\s*/, "").replace(/\s*\{.*$/, "").trim())
        .filter(Boolean);
      chunks.push({
        heading,
        heading_line: headingLine,
        breadcrumb,
        text: text.slice(0, maxChars),
      });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    // Ignore headings inside fenced code blocks.
    if (h && !isInsideFence(lines, i)) {
      flush();
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].match(/^#+/)[0].length >= level) {
        stack.pop();
      }
      stack.push(line);
      heading = line.replace(/^#+\s*/, "").replace(/\s*\{.*$/, "").trim();
      headingLine = i + 1;
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

function isInsideFence(lines, idx) {
  let fences = 0;
  for (let i = 0; i < idx; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fences++;
  }
  return fences % 2 === 1;
}

/**
 * Ingest a bevy-website checkout into records.
 * `bevyVersion` scopes migration/release records to the pinned version.
 */
export function ingestWebsite(websiteDir, bevyVersion) {
  if (!websiteDir || !fs.existsSync(websiteDir)) return [];

  const files = walkMarkdown(websiteDir, []);
  const records = [];

  for (const file of files) {
    const rel = path.relative(websiteDir, file).replace(/\\/g, "/");
    const info = classify(rel);

    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = splitFrontMatter(raw);
    if (!body.trim()) continue;

    const title =
      info.title || meta.long_title || meta.title || path.basename(file, ".md");
    // Zola hides unreleased/draft pages; keep them but flag them so the agent
    // does not treat a TODO placeholder as authoritative guidance.
    const draft = meta.status === "hidden" || meta.public_draft != null;

    const chunks = chunkByHeadings(body);
    const base = {
      source: "website",
      crate: "bevy-website",
      module: rel.split("/").slice(0, -1).join("::"),
      file: rel,
      source_ref: null,
      bevy_version: bevyVersion,
      owner: null,
      draft,
      version: info.version || null,
      pr: info.pr || null,
      from_version: info.from_version || null,
      to_version: info.to_version || null,
    };

    if (chunks.length <= 1) {
      records.push({
        ...base,
        kind: info.kind,
        name: title,
        full_path: `${info.kind}:${rel}`,
        signature: "",
        docs: body.trim().slice(0, 6000),
        heading: null,
        line_start: 1,
        title,
      });
      continue;
    }

    for (const c of chunks) {
      records.push({
        ...base,
        kind: info.kind,
        name: title,
        full_path: `${info.kind}:${rel}`,
        signature: "",
        docs: c.text,
        heading: c.heading,
        breadcrumb: c.breadcrumb,
        line_start: c.heading_line,
        title,
      });
    }
  }
  return records;
}

export const _internal = { splitFrontMatter, chunkByHeadings, classify, isInsideFence };