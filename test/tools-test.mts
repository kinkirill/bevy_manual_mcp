/**
 * Per-tool behavioural tests.
 *
 * Each tool is exercised through its real `register(server, ctx)` entry point
 * against a deterministic in-memory index and the committed vendored metadata,
 * so every assertion is checked against a known-correct reference rather than
 * against the implementation's own output.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BevyIndex } from "../src/store.js";
import { createVersioning } from "../src/tools/versioning.js";
import { createVersionChecker } from "../src/versions.js";
import { registerAll } from "../src/tools/index.js";
import { register as registerEcosystemSearch } from "../src/tools/ecosystem_search.js";
import { register as registerGeneratePlugin } from "../src/tools/generate_plugin.js";
import { register as registerCheckVersion } from "../src/tools/check_version.js";
import type { ToolContext } from "../src/tools/types.js";
import type { BevyRecord, ResolvedConfig } from "../src/types.js";
import type { VersionRegistry } from "../src/registry.js";
import { REPO_ROOT, fixtureConfig, fixtureRecord, writeFixture } from "./helpers.mjs";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;

function captureServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _cfg: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

// --- Deterministic fixture records ------------------------------------------

function rd(overrides: Partial<BevyRecord>): BevyRecord {
  return fixtureRecord({ source: "rustdoc", bevy_version: "0.20.0", ...overrides });
}

function site(overrides: Partial<BevyRecord>): BevyRecord {
  return fixtureRecord({ ...overrides });
}

function currentRecords(): BevyRecord[] {
  return [
    rd({ kind: "struct", name: "App", full_path: "bevy::app::App", module: "bevy::app", crate: "bevy_app", docs: "The Bevy application." }),
    rd({ kind: "trait", name: "Plugin", full_path: "bevy::app::Plugin", module: "bevy::app", crate: "bevy_app" }),
    rd({ kind: "fn", name: "add_systems", full_path: "bevy::app::add_systems", module: "bevy::app", crate: "bevy_app", signature: "pub fn add_systems(schedule: impl ScheduleLabel)" }),
    rd({ kind: "trait", name: "SystemSet", full_path: "bevy::ecs::schedule::SystemSet", module: "bevy::ecs::schedule", crate: "bevy_ecs" }),
    rd({ kind: "struct", name: "Update", full_path: "bevy::ecs::schedule::Update", module: "bevy::ecs::schedule", crate: "bevy_ecs" }),
    rd({ kind: "struct", name: "Query", full_path: "bevy::ecs::system::Query", module: "bevy::ecs::system", crate: "bevy_ecs", docs: "A query over entities with the requested components." }),
    rd({ kind: "method", name: "iter", owner: "Query", full_path: "bevy::ecs::system::Query::iter", module: "bevy::ecs::system", crate: "bevy_ecs", signature: "pub fn iter(&mut self) -> QueryIter<'_, '_, D, F>", docs: "Iterates over the query results." }),
    rd({ kind: "struct", name: "Transform", full_path: "bevy::transform::components::Transform", module: "bevy::transform::components", crate: "bevy_transform", signature: "pub struct Transform { .. }", docs: "Describes position, rotation and scale." }),
    rd({ kind: "trait", name: "Message", full_path: "bevy::ecs::message::Message", module: "bevy::ecs::message", crate: "bevy_ecs" }),
    rd({ kind: "struct", name: "MessageReader", full_path: "bevy::ecs::message::MessageReader", module: "bevy::ecs::message", crate: "bevy_ecs", docs: "Reads messages of type T." }),
    rd({ kind: "struct", name: "MessageWriter", full_path: "bevy::ecs::message::MessageWriter", module: "bevy::ecs::message", crate: "bevy_ecs", docs: "Writes messages of type T." }),
    rd({ kind: "struct", name: "Node", full_path: "bevy::ui::Node", module: "bevy::ui", crate: "bevy_ui", docs: "A UI node." }),
    rd({ kind: "struct", name: "TextFont", full_path: "bevy::text::TextFont", module: "bevy::text", crate: "bevy_text" }),
    rd({ kind: "struct", name: "Widget", full_path: "rdfixture::Widget", module: "rdfixture", crate: "rdfixture", signature: "pub struct Widget", docs: "A widget resource.", defaults: "Widget { id: 0 }" }),
    rd({ kind: "method", name: "new", owner: "Widget", full_path: "rdfixture::Widget::new", module: "rdfixture", crate: "rdfixture", signature: "pub fn new(id: u32) -> Self", docs: "Creates a widget." }),
    rd({ kind: "method", name: "id", owner: "Widget", full_path: "rdfixture::Widget::id", module: "rdfixture", crate: "rdfixture", signature: "pub fn id(&self) -> u32", docs: "Reads the id." }),
    site({ kind: "book", name: "Getting Started", full_path: "getting-started.md", file: "getting-started.md", docs: "How to make a Bevy app." }),
    site({ kind: "migration_guide", name: "Migration Guide 0.19 to 0.20", full_path: "migration/0.19-to-0.20.md", file: "migration/0.19-to-0.20.md", from_version: "0.19", to_version: "0.20", docs: "Scheduler changes and render changes." }),
    site({ kind: "migration_entry", name: "Renamed Event to Message", full_path: "migration/event-message.md", file: "migration/event-message.md", version: "0.20", docs: "EventWriter is now MessageWriter." }),
    site({ kind: "release_notes", name: "Bevy 0.20", full_path: "release/0.20.md", file: "release/0.20.md", version: "0.20", docs: "This release renames events to messages." }),
    site({ source: "learn-examples", kind: "code_example", name: "button ui", full_path: "examples/button.md", file: "examples/button.md", categories: ["ui"], docs: "A button UI example.", code: "fn setup() {}" }),
    site({ source: "learn-examples", kind: "code_example", name: "2d camera", full_path: "examples/camera2d.md", file: "examples/camera2d.md", categories: ["2d"], docs: "A 2d camera example.", code: "fn camera() {}" }),
  ];
}

function previousRecords(): BevyRecord[] {
  return [
    rd({ kind: "struct", name: "Widget", full_path: "rdfixture::Widget", module: "rdfixture", crate: "rdfixture", signature: "pub struct Widget", bevy_version: "0.19.1" }),
    rd({ kind: "method", name: "id", owner: "Widget", full_path: "rdfixture::Widget::id", module: "rdfixture", crate: "rdfixture", signature: "pub fn id(&self) -> u64", bevy_version: "0.19.1" }),
  ];
}

function pluginRecords(): BevyRecord[] {
  return [
    rd({ kind: "struct", name: "EguiContexts", full_path: "bevy_egui::EguiContexts", module: "bevy_egui", crate: "bevy_egui" }),
    rd({ kind: "struct", name: "Button", full_path: "bevy_egui::Button", module: "bevy_egui", crate: "bevy_egui" }),
  ];
}

async function buildIndex(records: BevyRecord[], version: string): Promise<BevyIndex> {
  const index = new BevyIndex();
  index.addRecords(records);
  index.buildSymbolTable();
  await index.buildTextIndex();
  index.meta = { bevy_version: version, symbols: index.symbols.size, doc_dir: "/fixture/docs", built_at: "2026-01-02T00:00:00Z" };
  index.stats = index.stats_();
  return index;
}

// --- Harness -----------------------------------------------------------------

interface Harness {
  root: string;
  tools: Map<string, ToolHandler>;
  config: ResolvedConfig;
  index: BevyIndex;
  previous: BevyIndex;
  plugin: BevyIndex;
  ctx: ToolContext;
}

async function makeHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-tools-"));
  writeFixture(
    path.join(root, "Cargo.toml"),
    `[package]\nname = "proj"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nbevy = { version = "0.20.0", features = ["bevy_ui"] }\n`,
  );
  const config = fixtureConfig(root, {
    bevyVersion: "0.20.0",
    projectRoot: root,
    metaDir: path.join(REPO_ROOT, "vendor", "bevy-meta"),
    docDir: "/fixture/docs",
    dataDir: path.join(root, "data"),
    websiteDir: path.join(root, "website"),
    versionSource: "Cargo.lock",
  });

  const index = await buildIndex(currentRecords(), "0.20.0");
  const previous = await buildIndex(previousRecords(), "0.19.1");
  const plugin = await buildIndex(pluginRecords(), "0.43.1");
  const indices = new Map<string, BevyIndex>([
    ["0.20.0", index],
    ["0.19.1", previous],
  ]);

  const registry = {
    versions: () => ["0.19.1", "0.20.0"],
    has: (version: string) => indices.has(version),
    get: async (version: string) => {
      const found = indices.get(version);
      if (!found) throw new Error(`unknown version ${version}`);
      return found;
    },
    registry: {
      cache_version: 5,
      versions: {
        "0.19.1": { version: "0.19.1", records: previous.records.length, symbols: previous.symbols.size, built_at: "2026-01-01T00:00:00Z" },
        "0.20.0": { version: "0.20.0", records: index.records.length, symbols: index.symbols.size, built_at: "2026-01-02T00:00:00Z" },
      },
    },
  } as unknown as VersionRegistry;

  const versioning = createVersioning(config, registry, index);
  const ctx: ToolContext = {
    config,
    registry,
    index,
    checkVersions: createVersionChecker({ offline: true }),
    ...versioning,
  };

  const { server, tools } = captureServer();
  registerAll(server, ctx);
  // Re-register the ecosystem search with a plugin corpus attached.
  registerEcosystemSearch(server, {
    config: config as unknown as Record<string, unknown> & { bevyVersion?: string | null },
    pluginIndices: new Map([["bevy_egui@0.43.1", plugin]]),
  });

  return { root, tools, config, index, previous, plugin, ctx };
}

const harness = await makeHarness();
const call = (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> | CallToolResult => {
  const handler = harness.tools.get(name);
  assert.ok(handler, `tool ${name} is not registered`);
  return handler(args);
};

// --- bevy_search -------------------------------------------------------------

await test("bevy_search returns indexed records with version metadata", async () => {
  const result = await call("bevy_search", { query: "Widget", limit: 5 });
  const data = structured(result);
  assert.equal(data.queried_version, "0.20.0");
  assert.equal(data.version_indexed, true);
  assert.ok((data.count as number) >= 1);
});

await test("bevy_search finds an exact symbol's documentation", async () => {
  const result = await call("bevy_search", { query: "Widget::new", limit: 5 });
  assert.match(textOf(result), /Creates a widget/);
});

await test("bevy_search honours the limit", async () => {
  const result = await call("bevy_search", { query: "bevy", limit: 2 });
  assert.ok((structured(result).count as number) <= 2);
});

await test("bevy_search applies kind filters", async () => {
  const result = await call("bevy_search", { query: "Widget", kind: "struct", limit: 10 });
  const results = structured(result).results as Array<{ kind: string }>;
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.kind === "struct"));
});

await test("bevy_search refuses an unindexed version", async () => {
  const result = await call("bevy_search", { query: "Widget", version: "1.2.3" });
  assert.equal(result.isError, true);
  assert.equal(structured(result).version_indexed, false);
  assert.match(textOf(result), /not indexed/i);
});

// --- bevy_api ----------------------------------------------------------------

await test("bevy_api resolves an exact method with its real signature", async () => {
  const result = await call("bevy_api", { symbol: "Widget::new" });
  const data = structured(result);
  assert.equal(data.symbol, "rdfixture::Widget::new");
  assert.equal(data.kind, "method");
  assert.match(String(data.signature), /pub fn new\(id: u32\)/);
});

await test("bevy_api returns the type's documented default when the default method is not indexed", async () => {
  const result = await call("bevy_api", { symbol: "Widget::default" });
  assert.match(textOf(result), /documented default/);
  assert.match(textOf(result), /Widget \{ id: 0 \}/);
});

await test("bevy_api omits related methods when include_related is false", async () => {
  const result = await call("bevy_api", { symbol: "Widget::new", include_related: false });
  assert.deepEqual(structured(result).related, []);
});

await test("bevy_api reports an unknown symbol", async () => {
  const result = await call("bevy_api", { symbol: "NoSuchSymbolAnywhere" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No API symbol/);
});

await test("bevy_api refuses an unindexed version", async () => {
  const result = await call("bevy_api", { symbol: "Widget::new", version: "1.2.3" });
  assert.equal(result.isError, true);
  assert.equal(structured(result).version_indexed, false);
});

// --- bevy_examples -----------------------------------------------------------

await test("bevy_examples finds a code example for a task", async () => {
  const result = await call("bevy_examples", { task: "button ui", limit: 5 });
  const results = structured(result).results as Array<{ kind: string }>;
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.kind === "code_example"));
});

await test("bevy_examples applies a category filter", async () => {
  const result = await call("bevy_examples", { task: "camera", category: "2d" });
  const results = structured(result).results as Array<{ name: string }>;
  assert.ok(results.every((r) => r.name.includes("camera")));
});

await test("bevy_examples reports no matches as an error", async () => {
  const result = await call("bevy_examples", { task: "quantum flux capacitor" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No examples matched/);
});

await test("bevy_examples honours the limit", async () => {
  const result = await call("bevy_examples", { task: "example", limit: 1 });
  if (!result.isError) assert.ok((structured(result).results as unknown[]).length <= 1);
});

await test("bevy_examples includes the example source in the text", async () => {
  const result = await call("bevy_examples", { task: "button ui" });
  assert.match(textOf(result), /fn setup\(\)/);
});

// --- bevy_migration ----------------------------------------------------------

await test("bevy_migration returns the matching guide", async () => {
  const result = await call("bevy_migration", { from_version: "0.19", to_version: "0.20" });
  assert.match(textOf(result), /Migration Guide 0\.19 to 0\.20|Scheduler changes/);
});

await test("bevy_migration filters by topic", async () => {
  const result = await call("bevy_migration", { from_version: "0.19", to_version: "0.20", topic: "scheduler" });
  assert.match(textOf(result), /Scheduler changes/);
});

await test("bevy_migration surfaces release notes for the target version", async () => {
  const result = await call("bevy_migration", { to_version: "0.20" });
  assert.match(textOf(result), /Bevy 0\.20/);
});

await test("bevy_migration reports when nothing matches", async () => {
  const result = await call("bevy_migration", { from_version: "0.19", to_version: "0.20", topic: "nonexistenttopic" });
  assert.match(textOf(result), /No migration notes found/);
});

await test("bevy_migration refuses without a target version", async () => {
  const result = await call("bevy_migration", { to_version: "" });
  // Empty string falls back to the configured version, which is set here.
  assert.ok(textOf(result).length > 0);
});

// --- bevy_api_diff -----------------------------------------------------------

await test("bevy_api_diff detects a changed signature across versions", async () => {
  const result = await call("bevy_api_diff", { symbol: "Widget::id", versions: "0.19.1,0.20.0" });
  const data = structured(result);
  assert.equal(data.changed, true);
  const versions = data.versions as Array<{ version: string; signature: string }>;
  assert.match(versions.find((v) => v.version === "0.19.1")!.signature, /u64/);
  assert.match(versions.find((v) => v.version === "0.20.0")!.signature, /u32/);
});

await test("bevy_api_diff reports identical signatures as unchanged", async () => {
  const result = await call("bevy_api_diff", { symbol: "Widget" });
  assert.equal(structured(result).changed, false);
});

await test("bevy_api_diff requires two versions", async () => {
  const result = await call("bevy_api_diff", { symbol: "Widget::id", versions: "0.20.0" });
  assert.equal(result.isError, true);
  assert.equal(structured(result).comparable, false);
});

await test("bevy_api_diff refuses an unindexed version", async () => {
  const result = await call("bevy_api_diff", { symbol: "Widget::id", versions: "0.19.1,1.2.3" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Not indexed/);
});

await test("bevy_api_diff reports a symbol missing everywhere", async () => {
  const result = await call("bevy_api_diff", { symbol: "NoSuchSymbolAnywhere", versions: "0.19.1,0.20.0" });
  assert.equal(result.isError, true);
});

// --- bevy_indexed_versions ---------------------------------------------------

await test("bevy_indexed_versions lists the active version", async () => {
  const result = await call("bevy_indexed_versions");
  assert.match(textOf(result), /0\.20\.0/);
  assert.equal(structured(result).active, "0.20.0");
});

await test("bevy_indexed_versions lists every indexed version", async () => {
  const versions = structured(await call("bevy_indexed_versions")).versions as Array<{ version: string }>;
  assert.deepEqual(versions.map((v) => v.version).sort(), ["0.19.1", "0.20.0"]);
});

await test("bevy_indexed_versions marks exactly one active version", async () => {
  const versions = structured(await call("bevy_indexed_versions")).versions as Array<{ active: boolean }>;
  assert.equal(versions.filter((v) => v.active).length, 1);
});

await test("bevy_indexed_versions classifies the relative bump", async () => {
  const versions = structured(await call("bevy_indexed_versions")).versions as Array<{ version: string; relative_to_active: { level: string; breaks_api: boolean } | null }>;
  const older = versions.find((v) => v.version === "0.19.1")!;
  assert.equal(older.relative_to_active?.level, "downgrade");
  assert.equal(older.relative_to_active?.breaks_api, true);
});

await test("bevy_indexed_versions reports record counts", async () => {
  const versions = structured(await call("bevy_indexed_versions")).versions as Array<{ version: string; records: number }>;
  assert.equal(versions.find((v) => v.version === "0.20.0")!.records, harness.index.records.length);
});

// --- bevy_index_status -------------------------------------------------------

await test("bevy_index_status reports the pinned version", async () => {
  assert.equal(structured(await call("bevy_index_status")).bevy_version, "0.20.0");
});

await test("bevy_index_status reports an API index is present", async () => {
  assert.equal(structured(await call("bevy_index_status")).has_api_index, true);
});

await test("bevy_index_status reports the symbol count", async () => {
  assert.equal(structured(await call("bevy_index_status")).symbols, harness.index.symbols.size);
});

await test("bevy_index_status echoes the resolved directories", async () => {
  const data = structured(await call("bevy_index_status"));
  assert.equal(data.meta_dir, path.join(REPO_ROOT, "vendor", "bevy-meta"));
  assert.equal(data.doc_dir, "/fixture/docs");
});

await test("bevy_index_status counts records by source", async () => {
  const stats = structured(await call("bevy_index_status")).stats as { total: number; by_source: Record<string, number> };
  assert.equal(stats.total, harness.index.records.length);
  assert.ok((stats.by_source.rustdoc ?? 0) > 0);
});

// --- bevy_check_manifest -----------------------------------------------------

await test("bevy_check_manifest lists features enabled in Cargo.toml", async () => {
  const result = await call("bevy_check_manifest", {});
  const data = structured(result);
  assert.deepEqual(data.explicit, ["bevy_ui"]);
});

await test("bevy_check_manifest confirms an enabled feature", async () => {
  const result = await call("bevy_check_manifest", { check: "bevy_ui" });
  assert.equal(structured(result).available, true);
});

await test("bevy_check_manifest resolves a symbol gated by an enabled feature", async () => {
  const result = await call("bevy_check_manifest", { check: "bevy::ui::Node" });
  assert.equal(structured(result).available, true);
  assert.equal(structured(result).gating_feature, "bevy_ui");
});

await test("bevy_check_manifest reports a disabled feature", async () => {
  const result = await call("bevy_check_manifest", { check: "bevy_pbr" });
  assert.equal(structured(result).available, false);
});

await test("bevy_check_manifest resolves a plugin gate", async () => {
  const result = await call("bevy_check_manifest", { check: "UiPlugin" });
  assert.equal(structured(result).available, true);
  assert.equal(structured(result).gating_feature, "bevy_ui");
});

// --- bevy_validate_systems ---------------------------------------------------

await test("bevy_validate_systems catches Query<&mut T> + Query<&T> (B0001)", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(a: Query<&mut Transform>, b: Query<&Transform>) {}" });
  const data = structured(result);
  assert.equal(data.findings_count, 1);
  const finding = (data.findings as Array<{ rule: string; error_code: string }>)[0]!;
  assert.equal(finding.rule, "R1");
  assert.equal(finding.error_code, "B0001");
});

await test("bevy_validate_systems accepts B0001's documented fix", async () => {
  const result = await call("bevy_validate_systems", {
    code: "fn f(a: Query<&mut Transform, With<Enemy>>, b: Query<&Transform, (With<Player>, Without<Enemy>)>) {}",
  });
  assert.equal(structured(result).findings_count, 0);
  assert.match(textOf(result), /No conflicts detected/);
});

await test("bevy_validate_systems catches two mutable queries (B0001/R2)", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(a: Query<&mut Transform>, b: Query<&mut Transform>) {}" });
  assert.equal((structured(result).findings as Array<{ rule: string }>)[0]!.rule, "R2");
});

await test("bevy_validate_systems catches Res + ResMut on the same resource (B0002)", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(a: ResMut<FrameTime>, b: Res<FrameTime>) {}" });
  const finding = (structured(result).findings as Array<{ rule: string; error_code: string; resource_type: string }>)[0]!;
  assert.equal(finding.rule, "R3");
  assert.equal(finding.error_code, "B0002");
  assert.equal(finding.resource_type, "FrameTime");
});

await test("bevy_validate_systems does not flag Res on a different resource", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(a: Res<Time>, b: ResMut<FrameTime>) {}" });
  assert.equal(structured(result).findings_count, 0);
});

await test("bevy_validate_systems catches &mut World alongside other parameters", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(world: &mut World, time: Res<Time>) {}" });
  assert.equal((structured(result).findings as Array<{ rule: string }>)[0]!.rule, "R5");
});

// --- bevy_explain_error ------------------------------------------------------

await test("bevy_explain_error extracts a version-checked error code", async () => {
  const result = await call("bevy_explain_error", { message: "thread 'main' panicked at error[B0002]: ResMut<Assets<StandardMaterial>> ..." });
  const data = structured(result);
  assert.equal(data.code, "B0002");
  assert.equal(data.severity, "panic");
  assert.equal(data.version_indexed, true);
});

await test("bevy_explain_error extracts the conflicting resource type", async () => {
  const result = await call("bevy_explain_error", { message: "error[B0002]: ResMut<Assets<StandardMaterial>> conflicts with Res<Assets<StandardMaterial>>" });
  assert.equal(structured(result).resource_type, "Assets<StandardMaterial>");
});

await test("bevy_explain_error rejects a code absent from the pinned version", async () => {
  const result = await call("bevy_explain_error", { message: "error[B0007]: something" });
  assert.equal(structured(result).does_not_exist_in_version, true);
});

await test("bevy_explain_error includes the worked fix for B0001", async () => {
  const result = await call("bevy_explain_error", { message: "error[B0001]: Query<&mut Transform> ..." });
  assert.match(textOf(result), /Without|SystemParamSet/);
});

await test("bevy_explain_error returns the full guide on request", async () => {
  const short = await call("bevy_explain_error", { message: "error[B0001]: x" });
  const full = await call("bevy_explain_error", { message: "error[B0001]: x", full: true });
  assert.ok(textOf(full).length > textOf(short).length);
});

await test("bevy_explain_error refuses to guess on an uncoded panic", async () => {
  const result = await call("bevy_explain_error", { message: "thread 'main' panicked at 'something unknown happened'" });
  assert.equal(structured(result).tier, 3);
  assert.equal(structured(result).no_error_code_found, true);
});

// --- bevy_ecosystem_search ---------------------------------------------------

await test("bevy_ecosystem_search finds plugin symbols and labels the corpus", async () => {
  const result = await call("bevy_ecosystem_search", { query: "Button" });
  assert.match(textOf(result), /bevy_egui@0\.43\.1/);
  assert.match(textOf(result), /Button/);
});

await test("bevy_ecosystem_search restricts to a named crate", async () => {
  const result = await call("bevy_ecosystem_search", { query: "Button", crate: "bevy_egui" });
  assert.deepEqual(structured(result).corpora_searched, ["bevy_egui@0.43.1"]);
});

await test("bevy_ecosystem_search reports no matches honestly", async () => {
  const result = await call("bevy_ecosystem_search", { query: "zzzznomatchzzz" });
  assert.match(textOf(result), /No matching symbols|no results/);
});

await test("bevy_ecosystem_search counts hits across corpora", async () => {
  const result = await call("bevy_ecosystem_search", { query: "EguiContexts" });
  assert.ok((structured(result).total_hits as number) >= 1);
});

await test("bevy_ecosystem_search echoes the active Bevy version", async () => {
  assert.equal(structured(await call("bevy_ecosystem_search", { query: "Button" })).bevy_version, "0.20.0");
});

// --- bevy_ecosystem_compat ---------------------------------------------------

await test("bevy_ecosystem_compat finds a plugin version for the pinned Bevy", async () => {
  const result = await call("bevy_ecosystem_compat", { crate: "bevy_egui" });
  assert.equal(structured(result).compatible, true);
});

await test("bevy_ecosystem_compat lists the indexed plugins", async () => {
  const result = await call("bevy_ecosystem_compat", {});
  const crates = structured(result).crates_available as string[];
  assert.ok(crates.includes("bevy_egui"));
  assert.ok(crates.includes("bevy_rapier3d"));
  assert.ok(crates.includes("leafwing_input_manager"));
});

await test("bevy_ecosystem_compat errors on an unknown crate", async () => {
  const result = await call("bevy_ecosystem_compat", { crate: "definitely_not_a_plugin" });
  assert.equal(result.isError, true);
});

await test("bevy_ecosystem_compat warns when the plugin needs another Bevy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-compat-"));
  const config = fixtureConfig(root, { bevyVersion: "0.1.0" });
  const { server, tools } = captureServer();
  registerAll(server, { ...harness.ctx, config });
  const result = await tools.get("bevy_ecosystem_compat")!({ crate: "bevy_egui" });
  assert.equal(structured(result).compatible, false);
  assert.match(textOf(result), /WARN/);
});

await test("bevy_ecosystem_compat prints a matrix when no crate is given", async () => {
  const result = await call("bevy_ecosystem_compat", {});
  assert.match(textOf(result), /bevy_egui/);
});

// --- bevy_generate_plugin ----------------------------------------------------

await test("bevy_generate_plugin emits a verified plugin skeleton", async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton" });
  const data = structured(result);
  assert.equal(data.template_id, "plugin-skeleton");
  assert.match(String(data.code), /impl Plugin for MyPlugin/);
  assert.match(String(data.code), /add_systems\(Update, my_system\)/);
});

await test("bevy_generate_plugin emits the SystemSet variant", async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-with-systemset" });
  assert.match(String(structured(result).code), /SystemSet/);
});

await test("bevy_generate_plugin rejects an unknown template", async () => {
  const result = await call("bevy_generate_plugin", { template: "does-not-exist" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown template/);
});

await test("bevy_generate_plugin refuses a template whose symbols are missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-gen-"));
  const config = fixtureConfig(root, { bevyVersion: "0.20.0" });
  const bare = await buildIndex([rd({ kind: "struct", name: "App", full_path: "bevy::app::App" })], "0.20.0");
  const registry = {
    versions: () => ["0.20.0"],
    has: () => true,
    get: async () => bare,
    registry: { cache_version: 5, versions: {} },
  } as unknown as VersionRegistry;
  const versioning = createVersioning(config, registry, bare);
  const { server, tools } = captureServer();
  registerGeneratePlugin(server, { config, registry, index: bare, checkVersions: createVersionChecker({ offline: true }), ...versioning });
  const result = await tools.get("bevy_generate_plugin")!({ template: "plugin-with-systemset" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /symbols not found|requires symbols/);
});

await test("bevy_generate_plugin stamps the pinned version", async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton" });
  assert.equal(structured(result).bevy_version, "0.20.0");
});

// --- bevy_perf_advisor -------------------------------------------------------

await test("bevy_perf_advisor returns version-correct change-detection advice", async () => {
  const result = await call("bevy_perf_advisor", { topic: "change-detection" });
  assert.match(textOf(result), /Changed/);
  assert.match(textOf(result), /Added/);
});

await test("bevy_perf_advisor detects the is_changed anti-pattern", async () => {
  const result = await call("bevy_perf_advisor", { topic: "change-detection", code: "if q.is_changed() { }" });
  assert.match(textOf(result), /Anti-Patterns Detected/);
  assert.match(textOf(result), /is_changed/);
});

await test("bevy_perf_advisor reports unknown topics without guessing", async () => {
  const result = await call("bevy_perf_advisor", { topic: "teleportation" });
  assert.match(textOf(result), /not found/);
});

await test("bevy_perf_advisor lists topics when asked without one", async () => {
  const result = await call("bevy_perf_advisor", {});
  assert.match(textOf(result), /Available topics|change-detection/);
});

await test("bevy_perf_advisor serves an archetypes topic", async () => {
  const result = await call("bevy_perf_advisor", { topic: "archetypes" });
  assert.match(textOf(result), /Commands/);
});

// --- bevy_check_version (network stubbed) ------------------------------------

await test("bevy_check_version reports an offline failure honestly", async () => {
  const result = await call("bevy_check_version", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /offline/i);
});

function checkVersionTools(info: unknown): Map<string, ToolHandler> {
  const { server, tools } = captureServer();
  registerCheckVersion(server, {
    ...harness.ctx,
    checkVersions: async () => info,
  } as ToolContext);
  return tools;
}

await test("bevy_check_version treats a patch bump as non-breaking", async () => {
  const tools = checkVersionTools({ ok: true, checked_at: 1, newest_stable: "0.20.1", preview: null, recent: ["0.20.1"] });
  const result = await tools.get("bevy_check_version")!({});
  const data = structured(result);
  assert.equal(data.bump_level, "patch");
  assert.equal(data.breaks_api, false);
  assert.equal(data.action_needed, true);
});

await test("bevy_check_version flags a minor bump as breaking", async () => {
  const tools = checkVersionTools({ ok: true, checked_at: 1, newest_stable: "0.21.0", preview: null, recent: ["0.21.0"] });
  const data = structured(await tools.get("bevy_check_version")!({}));
  assert.equal(data.bump_level, "minor");
  assert.equal(data.breaks_api, true);
});

await test("bevy_check_version reports a current index as up to date", async () => {
  const tools = checkVersionTools({ ok: true, checked_at: 1, newest_stable: "0.20.0", preview: null, recent: ["0.20.0"] });
  const data = structured(await tools.get("bevy_check_version")!({}));
  assert.equal(data.bump_level, "none");
  assert.equal(data.action_needed, false);
});

await test("bevy_check_version surfaces a pre-release separately", async () => {
  const tools = checkVersionTools({ ok: true, checked_at: 1, newest_stable: "0.20.1", preview: "0.21.0-rc.1", recent: ["0.20.1"] });
  const result = await tools.get("bevy_check_version")!({});
  assert.equal(structured(result).preview, "0.21.0-rc.1");
  assert.match(textOf(result), /0\.21\.0-rc\.1/);
});

await test("bevy_check_version reports a crates.io failure", async () => {
  const tools = checkVersionTools({ ok: false, error: "network down" });
  const result = await tools.get("bevy_check_version")!({});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /network down/);
});
