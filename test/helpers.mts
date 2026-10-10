import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, resolveConfig } from "../src/config.js";
import type { ResolvedConfig } from "../src/types.js";
import { parseRecord } from "../src/types.js";
import type { BevyRecord } from "../src/types.js";

export { REPO_ROOT };

export function fixtureRecord(overrides: Partial<BevyRecord> = {}): BevyRecord {
  return parseRecord({ source: "website", kind: "book", name: "Fixture", full_path: "fixture.md", docs: "", signature: "", module: "", file: "fixture.md", ...overrides });
}

export function tempDir(prefix = "bevy-mcp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFixture(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

export function fixtureConfig(root: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...resolveConfig(),
    projectRoot: root,
    bevyVersion: "9.9.9",
    versionSource: "test",
    versionNote: undefined,
    configPath: null,
    docVersion: null,
    docVersionSource: null,
    docDir: null,
    websiteDir: null,
    examplesDir: null,
    bevySrcDir: null,
    errorsDir: null,
    dataDir: path.join(root, "data"),
    mirrorDir: path.join(root, "mirror"),
    env: { offline: true, maxResults: 8, debug: false },
    ...overrides,
  };
}

export function buildRustdocFixture(root: string): string {
  const crate = path.join(root, "rdfixture");
  writeFixture(path.join(crate, "Cargo.toml"), '[package]\nname = "rdfixture"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFixture(path.join(crate, "src", "lib.rs"), `/// A widget resource.
///
/// # Example
///
/// \`\`\`
/// let w = Widget::new(7);
/// assert_eq!(w.id(), 7);
/// \`\`\`
pub struct Widget {
    /// The widget's unique id.
    pub id: u32,
    /// The widget's display label.
    pub label: String,
}

/// A widget stored in tuple form.
pub struct TupleWidget(pub u32, pub String);

impl Widget {
    /// Creates a widget.
    ///
    /// \`\`\`
    /// let w = Widget::new(1);
    /// \`\`\`
    pub fn new(id: u32) -> Self { Self { id, label: String::new() } }
    /// Reads the id.
    pub fn id(&self) -> u32 { self.id }
}

/// Marker for widget-like things.
pub struct WithWidget;

pub fn spawn_widget() {}

${Array.from({ length: 60 }, (_, i) => `/// Generates a widget variant ${i}.\npub fn widget_variant_${i}(id: u32) -> u32 { id }`).join("\n\n")}
`);
  execFileSync("cargo", ["doc", "--no-deps", "--offline", "-q"], { cwd: crate, stdio: "pipe" });
  return path.join(crate, "target", "doc");
}

export async function protocolFixture(): Promise<{ root: string; dataDir: string; owned: boolean }> {
  const owned = !process.env.RESOURCE_FIXTURE_DIR;
  const root = process.env.RESOURCE_FIXTURE_DIR ?? tempDir("bevy-mcp-protocol-");
  const dataDir = path.join(root, "data-registry");
  if (owned) {
    try {
      const docDir = buildRustdocFixture(root);
      const { VersionRegistry } = await import("../src/registry.js");
      await new VersionRegistry(fixtureConfig(root, { docDir, dataDir })).get("9.9.9");
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  return { root, dataDir, owned };
}

// Isolate subprocesses from developer-specific Bevy configuration.
export function fixtureEnv(root: string, dataDir: string, version = "9.9.9"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("BEVY_") && key !== "INIT_CWD") env[key] = value;
  }
  const configPath = path.join(root, "isolated.config.json");
  writeFixture(configPath, JSON.stringify({ offline: true, websiteDir: path.join(root, "empty-website") }));
  fs.mkdirSync(path.join(root, "empty-website"), { recursive: true });
  return {
    ...env,
    BEVY_MCP_CONFIG: configPath,
    BEVY_PROJECT_ROOT: root,
    BEVY_VERSION: version,
    BEVY_DOC_DIR: path.join(root, "rdfixture", "target", "doc"),
    BEVY_MCP_DATA_DIR: dataDir,
    BEVY_MCP_OFFLINE: "1",
  };
}

export function errorCode(error: unknown): number | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

export function parseObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}
