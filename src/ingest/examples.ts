/** Ingest engine and website Rust examples with adjacent Cargo feature metadata. */

import fs from "node:fs";
import path from "node:path";
import type { CodeExampleRecord } from "../types.js";

/** Path categories match against a leading separator, including relative paths. */
const CATEGORY_RULES: [RegExp, string][] = [
  [/[/\\]2d[/\\]/, "2d"],
  [/[/\\]3d[/\\]/, "3d"],
  [/[/\\]ui[/\\]|[/\\]ui\.rs$/, "ui"],
  [/[/\\]input[/\\]|keyboard|mouse|gamepad|input\.rs$/, "input"],
  [/[/\\]audio[/\\]|[/\\]audio\.rs$/, "audio"],
  [/[/\\]asset[/\\]|assets/, "assets"],
  [/[/\\]ecs[/\\]|system|schedule|query|component/, "ecs"],
  [/[/\\]state[/\\]|state\.rs$/, "state"],
  [/[/\\]time[/\\]|timer/, "time"],
  [/[/\\]window[/\\]|window\.rs$/, "window"],
  [/[/\\]render[/\\]|camera|material|mesh/, "render"],
  [/[/\\]scene[/\\]|gltf|scn/, "scene"],
  [/[/\\]gizmo/, "gizmos"],
  [/[/\\]animation[/\\]|animat/, "animation"],
  [/[/\\]light/, "lighting"],
  [/[/\\]font|ui_text|[/\\]text\.rs$/, "text"],
  [/[/\\]transform/, "transforms"],
  [/[/\\]diagnostic|error/, "diagnostics"],
  [/[/\\]math[/\\]/, "math"],
  [/[/\\]ecs[/\\]observer|observ/, "observers"],
];

function categorise(rel: string) {
  const tags = new Set<string>();
  const withSlash = rel.startsWith("/") ? rel : "/" + rel;
  for (const [re, tag] of CATEGORY_RULES) {
    if (re.test(withSlash)) tags.add(tag);
  }
  return [...tags];
}

/** The `//!` module comment at the top of a bevy example describes it. */
function moduleDoc(code: string) {
  const lines = code.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("//!") || t.startsWith("//!")) out.push(t.replace(/^\/\/!\s?/, ""));
    else if (out.length > 0 && t.trim() === "") continue;
    else break;
  }
  return out.join("\n").trim();
}

function readCargoFeatures(dir: string) {
  const toml = path.join(dir, "Cargo.toml");
  if (!fs.existsSync(toml)) return null;
  try {
    const text = fs.readFileSync(toml, "utf8");
    const out: string[] = [];
    const entry = /^\s*\{\s*path\s*=\s*"([^"]+)"\s*(.*)\}\s*$/gm;
    let m;
    while ((m = entry.exec(text)) !== null) out.push(m[1] ?? "");
    const fe = text.match(/^\s*default\s*=\s*\[([\s\S]*?)\]/m);
    const features = fe
      ? (fe[1] ?? "")
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
      : [];
    return { examples: out, default_features: features };
  } catch {
    return null;
  }
}

function walkRs(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRs(full, out, depth + 1);
    else if (e.name.endsWith(".rs")) out.push(full);
  }
  return out;
}

function ingestDir(root: string | null, label: CodeExampleRecord["source"], bevyVersion: string | null): CodeExampleRecord[] {
  if (!root || !fs.existsSync(root)) return [];
  const records: CodeExampleRecord[] = [];
  for (const file of walkRs(root)) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    let code;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const dirMeta = readCargoFeatures(path.dirname(file));
    const doc = moduleDoc(code);
    const name = path.basename(file, ".rs").replace(/\.rs$/, "");
    records.push({
      source: label,
      kind: "code_example",
      name,
      full_path: `${label}:${rel}`,
      owner: null,
      crate: label,
      module: path.dirname(rel).replace(/\//g, "::"),
      signature: "",
      // Put the description before code for search ranking.
      docs: doc ? `${doc}\n\n\`\`\`rust\n${code}\n\`\`\`` : "```rust\n" + code + "\n```",
      description: doc,
      code,
      file: rel,
      file_abs: file,
      line_count: code.split(/\r?\n/).length,
      categories: categorise(rel),
      required_features: dirMeta?.default_features || [],
      bevy_version: bevyVersion,
      source_ref: null,
      title: name,
    });
  }
  return records;
}

/** Ingest engine and website examples tagged with the pinned version. */
export function ingestExamples({ examplesDir, websiteDir, bevyVersion }: {
  examplesDir: string | null; websiteDir: string | null; bevyVersion: string | null;
}): CodeExampleRecord[] {
  const records: CodeExampleRecord[] = [];

  if (examplesDir) {
    records.push(...ingestDir(examplesDir, "bevy-examples", bevyVersion));
  }
  if (websiteDir) {
    const lc = path.join(websiteDir, "learning-code-examples", "examples");
    records.push(...ingestDir(lc, "learn-examples", bevyVersion));
  }
  return records;
}

export const _internal = { categorise, moduleDoc };
