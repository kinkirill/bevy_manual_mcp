/** Ingest website guides and release notes as citable heading-scoped records. */

import fs from "node:fs";
import path from "node:path";
import type { WebsiteRecord } from "../types.js";

interface FrontMatter { title?: string; weight?: number; status?: string; long_title?: string; public_draft?: unknown }
interface FileInfo { kind: string; title?: string | null; from_version?: string; to_version?: string; version?: string; pr?: number | null }
interface MarkdownChunk { heading: string | null; heading_line: number; breadcrumb: string[]; text: string }

/** Strip a Zola/TOML front matter block and parse the few keys we care about. */
function splitFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const m = text.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: FrontMatter = {};
  const fm = m[1] ?? "";
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

function walkMarkdown(dir: string, out: string[] = []): string[] {
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
function classify(rel: string): FileInfo {
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
    const slug = (relMig[3] ?? "").replace(/_/g, " ");
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
      title: (relNotes[2] ?? "").replace(/_/g, " "),
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
  // Mark nontechnical pages for weight-zero exclusion.
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

/** Split headings into bounded chunks with citation breadcrumbs. */
function chunkByHeadings(body: string, { maxChars = 4000 }: { maxChars?: number } = {}): MarkdownChunk[] {
  const lines = body.split(/\r?\n/);
  const chunks: MarkdownChunk[] = [];
  const stack: string[] = [];

  let heading: string | null = null;
  let headingLine = 0;
  let buf: string[] = [];

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
    const line = lines[i] ?? "";
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    // Ignore headings inside fenced code blocks.
    if (h && !isInsideFence(lines, i)) {
      flush();
      const level = (h[1] ?? "").length;
      while (stack.length && ((stack[stack.length - 1] ?? "").match(/^#+/)?.[0].length ?? 0) >= level) {
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

function isInsideFence(lines: string[], idx: number) {
  let fences = 0;
  for (let i = 0; i < idx; i++) {
    if (/^\s*(```|~~~)/.test(lines[i] ?? "")) fences++;
  }
  return fences % 2 === 1;
}

/** Ingest website records tagged with the pinned Bevy version. */
export function ingestWebsite(websiteDir: string | null, bevyVersion: string | null): WebsiteRecord[] {
  if (!websiteDir || !fs.existsSync(websiteDir)) return [];

  const files = walkMarkdown(websiteDir, []);
  const records: WebsiteRecord[] = [];

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
    // Flag draft pages so placeholders can be filtered out.
    const draft = meta.status === "hidden" || meta.public_draft != null;

    const chunks = chunkByHeadings(body);
    const base: Omit<WebsiteRecord, "kind" | "name" | "full_path" | "signature" | "docs"> = {
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
