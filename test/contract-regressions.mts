/**
 * Phase 0 contract regressions.
 *
 * This file is the executable half of `docs/tool-contracts.md`. It contains:
 *
 *   1. Passing contract tests that lock in behaviour the tools already get
 *      right, so a later fix cannot silently regress it.
 *   2. `todo` tests for the confirmed P0/P1 findings in the plan. A `todo` test
 *      states the *expected* behaviour and currently fails because the handler
 *      does not implement it yet. Node reports it as `todo` and exits 0, so the
 *      suite stays green while a discrepancy is open.
 *
 * When a fix lands, delete the `{ todo: … }` option. The test then becomes a
 * hard gate that fails against the old behaviour and passes against the new.
 *
 * The index used here is built from deterministic in-memory records at a fixed
 * `0.20.0`, independent of the Bevy version active on the developer machine.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BevyIndex, hybridSearch } from "../src/store.js";
import { createVersioning } from "../src/tools/versioning.js";
import { createVersionChecker } from "../src/versions.js";
import { CorpusRegistry } from "../src/registry.js";
import { registerAll } from "../src/tools/index.js";
import { register as registerEcosystemCompat } from "../src/tools/ecosystem_compat.js";
import type { EcosystemCorpus, EcosystemFailure, EcosystemToolContext } from "../src/tools/ecosystem_search.js";
import { satisfiesRequirement } from "../src/analysis/compat.js";
import { parseRecord } from "../src/types.js";
import type { BevyRecord, ResolvedConfig } from "../src/types.js";
import type { VersionRegistry } from "../src/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { REPO_ROOT, fixtureConfig, fixtureRecord } from "./helpers.mjs";

const FIXTURES = path.join(REPO_ROOT, "test", "fixtures");
const META_DIR = path.join(REPO_ROOT, "vendor", "bevy-meta");

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;

/** Tools that must be registered and documented, in the order the doc lists them. */
const EXPECTED_TOOLS = [
  "bevy_search",
  "bevy_api",
  "bevy_examples",
  "bevy_migration",
  "bevy_api_diff",
  "bevy_check_version",
  "bevy_indexed_versions",
  "bevy_index_status",
  "bevy_check_manifest",
  "bevy_validate_systems",
  "bevy_explain_error",
  "bevy_ecosystem_search",
  "bevy_ecosystem_compat",
  "bevy_generate_plugin",
  "bevy_perf_advisor",
] as const;

interface CapturedServer {
  server: McpServer;
  tools: Map<string, ToolHandler>;
  configs: Map<string, Record<string, unknown>>;
}

function captureServer(): CapturedServer {
  const tools = new Map<string, ToolHandler>();
  const configs = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool(name: string, cfg: unknown, handler: ToolHandler) {
      tools.set(name, handler);
      configs.set(name, cfg as Record<string, unknown>);
    },
  } as unknown as McpServer;
  return { server, tools, configs };
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

// --- Deterministic fixture index --------------------------------------------

function rd(overrides: Partial<BevyRecord>): BevyRecord {
  return fixtureRecord({ source: "rustdoc", bevy_version: "0.20.0", ...overrides });
}

function primaryRecords(): BevyRecord[] {
  return [
    rd({ kind: "struct", name: "App", full_path: "bevy::app::App", module: "bevy::app", crate: "bevy_app", docs: "The Bevy application." }),
    rd({ kind: "trait", name: "Plugin", full_path: "bevy::app::Plugin", module: "bevy::app", crate: "bevy_app" }),
    rd({ kind: "fn", name: "add_systems", full_path: "bevy::app::add_systems", module: "bevy::app", crate: "bevy_app", signature: "pub fn add_systems(schedule: impl ScheduleLabel)" }),
    rd({ kind: "trait", name: "SystemSet", full_path: "bevy::ecs::schedule::SystemSet", module: "bevy::ecs::schedule", crate: "bevy_ecs" }),
    rd({ kind: "struct", name: "Update", full_path: "bevy::ecs::schedule::Update", module: "bevy::ecs::schedule", crate: "bevy_ecs" }),
    rd({ kind: "struct", name: "Query", full_path: "bevy::ecs::system::Query", module: "bevy::ecs::system", crate: "bevy_ecs" }),
    rd({ kind: "method", name: "iter", owner: "Query", full_path: "bevy::ecs::system::Query::iter", module: "bevy::ecs::system", crate: "bevy_ecs", signature: "pub fn iter(&mut self)" }),
    rd({ kind: "struct", name: "Transform", full_path: "bevy::transform::components::Transform", module: "bevy::transform::components", crate: "bevy_transform" }),
    rd({ kind: "struct", name: "Velocity", full_path: "bevy::transform::components::Velocity", module: "bevy::transform::components", crate: "bevy_transform" }),
    rd({ kind: "struct", name: "Node", full_path: "bevy::ui::Node", module: "bevy::ui", crate: "bevy_ui", docs: "A UI node." }),
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

async function buildEcosystem(config: ResolvedConfig, index: BevyIndex): Promise<EcosystemToolContext> {
  const corpusRegistry = new CorpusRegistry(config);
  const statuses = await corpusRegistry.loadConfigured();
  const corpora: EcosystemCorpus[] = config.bevyVersion
    ? [{ id: `bevy@${config.bevyVersion}`, crate: "bevy", version: config.bevyVersion, source: "bevy-index", index }]
    : [];
  for (const [id, corpusIndex] of corpusRegistry.pluginIndices) {
    const status = corpusRegistry.statuses.get(id);
    corpora.push({
      id,
      crate: status?.crate ?? id.split("@")[0]!,
      version: status?.version ?? corpusIndex.meta?.crate_version ?? null,
      source: status?.source ?? "rustdoc",
      index: corpusIndex,
    });
  }
  const failures: EcosystemFailure[] = statuses
    .filter((status) => !status.loaded)
    .map((status) => ({ id: status.id, crate: status.crate, version: status.version, reason: status.reason ?? "failed to load" }));
  return {
    config: config as unknown as Record<string, unknown> & { bevyVersion?: string | null },
    corpora,
    failures,
    configured: (config.corpora?.length ?? 0) > 0,
  };
}

interface Harness {
  root: string;
  index: BevyIndex;
  config: ResolvedConfig;
  tools: Map<string, ToolHandler>;
  configs: Map<string, Record<string, unknown>>;
}

async function makeHarness(overrides: Partial<ResolvedConfig> = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-contract-"));
  const config = fixtureConfig(root, {
    bevyVersion: "0.20.0",
    metaDir: META_DIR,
    docDir: "/fixture/docs",
    projectRoot: path.join(FIXTURES, "projects", "minimal"),
    versionSource: "fixture",
    ...overrides,
  });
  const index = await buildIndex(primaryRecords(), "0.20.0");
  const registry = {
    versions: () => ["0.20.0"],
    has: (version: string) => version === "0.20.0",
    get: async () => index,
    registry: {
      cache_version: 5,
      versions: {
        "0.20.0": { version: "0.20.0", records: index.records.length, symbols: index.symbols.size, built_at: "2026-01-02T00:00:00Z" },
      },
    },
  } as unknown as VersionRegistry;
  const ctx: ToolContext = {
    config,
    registry,
    index,
    checkVersions: createVersionChecker({ offline: true }),
    ...createVersioning(config, registry, index),
  };
  const { server, tools, configs } = captureServer();
  registerAll(server, ctx, await buildEcosystem(config, index));
  return { root, index, config, tools, configs };
}

const harness = await makeHarness();
const call = (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> | CallToolResult => {
  const handler = harness.tools.get(name);
  assert.ok(handler, `tool ${name} is not registered`);
  return handler(args);
};

// --- Registry, docs and fixtures --------------------------------------------

await test("registry: every documented tool is registered and the doc map is complete", () => {
  for (const name of EXPECTED_TOOLS) {
    assert.ok(harness.tools.has(name), `tool ${name} is not registered`);
    assert.ok(harness.configs.has(name), `tool ${name} has no config`);
    assert.ok(String((harness.configs.get(name)?.description ?? "")).length > 0, `tool ${name} has no description`);
  }
  assert.equal(harness.tools.size, EXPECTED_TOOLS.length, "registered tool count drifted from EXPECTED_TOOLS");

  const contracts = fs.readFileSync(path.join(REPO_ROOT, "docs", "tool-contracts.md"), "utf8");
  for (const name of EXPECTED_TOOLS) {
    assert.ok(contracts.includes("`" + name + "`"), `docs/tool-contracts.md does not mention ${name}`);
  }
});

await test("fixture: project fixtures are valid TOML with a bevy dependency", () => {
  for (const name of ["minimal", "no-default-features", "feature-rich"]) {
    const text = fs.readFileSync(path.join(FIXTURES, "projects", name, "Cargo.toml"), "utf8");
    assert.doesNotThrow(() => parseToml(text), `${name}/Cargo.toml should parse`);
    assert.match(text, /bevy/, `${name}/Cargo.toml should declare bevy`);
  }
});

await test("fixture: the configured plugin corpus records load and are searchable", async () => {
  const dir = path.join(FIXTURES, "ecosystem", "bevy_egui");
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "corpus.json"), "utf8")) as { records: string };
  const lines = fs.readFileSync(path.join(dir, descriptor.records), "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = lines.map((line) => parseRecord(JSON.parse(line)));
  const index = await buildIndex(records, "0.43.1");
  const hits = hybridSearch(index, "Button", { limit: 5 });
  assert.ok(hits.some((hit) => hit.record.full_path === "bevy_egui::Button"));
});

// --- Passing contracts -------------------------------------------------------

await test("search: refuses an unindexed version instead of substituting the active index", async () => {
  const result = await call("bevy_search", { query: "Transform", version: "9.9.9" });
  assert.equal(result.isError, true);
  assert.equal(structured(result).version_indexed, false);
});

await test("manifest: an explicitly requested feature is reported enabled", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "no-default-features") });
  const result = await h.tools.get("bevy_check_manifest")!({ check: "bevy_ui" });
  assert.equal(structured(result).available, true);
});

await test("compat: caret on 0.2.x spans the 0.2 line but not 0.3", () => {
  assert.equal(satisfiesRequirement("^0.2.3", "0.2.9"), true);
  assert.equal(satisfiesRequirement("^0.2.3", "0.3.0"), false);
});

await test("compat: tilde allows patch updates only", () => {
  assert.equal(satisfiesRequirement("~0.20.0", "0.20.5"), true);
  assert.equal(satisfiesRequirement("~0.20.0", "0.21.0"), false);
});

await test("compat: an exact requirement matches one version only", () => {
  assert.equal(satisfiesRequirement("0.20.0", "0.20.0"), true);
  assert.equal(satisfiesRequirement("0.20.0", "0.20.1"), false);
});

await test("validate: filters that prove disjointness suppress the conflict", async () => {
  const result = await call("bevy_validate_systems", {
    code: "fn f(a: Query<(&mut Transform,), With<Enemy>>, b: Query<&mut Transform, Without<Enemy>>) {}",
  });
  assert.equal(structured(result).findings_count, 0);
});

await test("generate: an unknown template is rejected", async () => {
  const result = await call("bevy_generate_plugin", { template: "does-not-exist" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown template/);
});

// --- C-01 ecosystem search ---------------------------------------------------

await test("ecosystem search: registerAll searches the configured plugin corpus", async () => {
  const h = await makeHarness({
    corpora: [{ crate: "bevy_egui", version: "0.43.1", indexDir: path.join(FIXTURES, "ecosystem", "bevy_egui"), source: "fixture" }],
  });
  const result = await h.tools.get("bevy_ecosystem_search")!({ query: "EguiContexts" });
  const data = structured(result);
  assert.ok((data.corpora_searched as string[]).includes("bevy_egui@0.43.1"), "configured corpus was not searched");
  assert.ok((data.total_hits as number) >= 1, "the plugin symbol was not found");
});

await test("ecosystem search: with no plugin corpora it searches Bevy only and says so", async () => {
  const result = await call("bevy_ecosystem_search", { query: "Transform" });
  const data = structured(result);
  assert.deepEqual(data.corpora_searched, ["bevy@0.20.0"]);
  assert.equal(data.plugin_corpora_configured, 0);
  assert.match(textOf(result), /No plugin corpora are configured/);
});

await test("ecosystem search: an unknown crate produces a clear response", async () => {
  const result = await call("bevy_ecosystem_search", { query: "Button", crate: "definitely_missing" });
  assert.equal(result.isError, true);
  assert.deepEqual(structured(result).corpora_searched, []);
  assert.ok((structured(result).available_corpora as string[]).includes("bevy@0.20.0"));
  assert.match(textOf(result), /No configured corpus matches/);
});

await test("ecosystem search: one failed corpus beside one healthy corpus is reported", async () => {
  const h = await makeHarness({
    corpora: [
      { crate: "bevy_egui", version: "0.43.1", indexDir: path.join(FIXTURES, "ecosystem", "bevy_egui"), source: "fixture" },
      { crate: "missing_plugin", version: "0.1.0" },
    ],
  });
  const result = await h.tools.get("bevy_ecosystem_search")!({ query: "Button" });
  const data = structured(result);
  assert.ok((data.corpora_searched as string[]).includes("bevy_egui@0.43.1"));
  assert.equal((data.failures as unknown[]).length, 1);
  assert.match(textOf(result), /no docDir|failed to load/);
});

// --- C-02 feature detection --------------------------------------------------

await test("manifest: implicit default features are reported enabled", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "minimal") });
  const result = await h.tools.get("bevy_check_manifest")!({});
  const data = structured(result);
  assert.equal(data.default_features_enabled, true);
  assert.ok((data.transitive as string[]).length > 0, "implicit defaults produced no features");
});

await test("manifest: default-features = false is represented", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "no-default-features") });
  const result = await h.tools.get("bevy_check_manifest")!({});
  const data = structured(result);
  assert.equal(data.default_features_enabled, false);
  assert.ok((data.transitive as string[]).includes("bevy_ui"));
});

await test("manifest: a package alias is resolved", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "feature-rich", "app") });
  const result = await h.tools.get("bevy_check_manifest")!({});
  assert.ok((structured(result).explicit as string[]).includes("bevy_audio"), "alias_bevy's feature was dropped");
});

await test("manifest: workspace inheritance does not leak other crates' features", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "feature-rich") });
  const result = await h.tools.get("bevy_check_manifest")!({});
  const explicit = structured(result).explicit as string[];
  assert.ok(explicit.includes("bevy_ui"), "inherited Bevy feature missing");
  assert.ok(!explicit.includes("derive"), "serde's feature leaked into the Bevy report");
});

await test("manifest: target-specific Bevy features are considered", async () => {
  const h = await makeHarness({ projectRoot: path.join(FIXTURES, "projects", "feature-rich", "app") });
  const result = await h.tools.get("bevy_check_manifest")!({});
  assert.ok((structured(result).explicit as string[]).includes("webgl2"), "target-specific feature was dropped");
});

// --- C-03 / C-04 / C-05 / C-06 ECS analyzer ---------------------------------

await test("validate: tuple member mutability is not leaked onto a read member", async () => {
  const result = await call("bevy_validate_systems", {
    code: "fn f(a: Query<(&Transform, &mut Velocity)>, b: Query<&mut Transform>) {}",
  });
  const findings = structured(result).findings as Array<{ rule: string; resource_type: string }>;
  assert.equal(findings.length, 1);
  // Transform is read in `a` and written in `b`: a read/write (R1) conflict, not
  // an all-mutable (R2) one caused by `&mut Velocity`.
  assert.equal(findings[0]!.rule, "R1");
  assert.equal(findings[0]!.resource_type, "Transform");
});

await test("validate: tuple Query read of one member and read of another is clean", async () => {
  const result = await call("bevy_validate_systems", {
    code: "fn f(a: Query<(&Transform, &mut Velocity)>, b: Query<&Transform>) {}",
  });
  assert.equal(structured(result).findings_count, 0);
});

await test("validate: tuple Query detects a conflict on the mutable member", async () => {
  const result = await call("bevy_validate_systems", {
    code: "fn f(a: Query<(&Transform, &mut Velocity)>, b: Query<&mut Velocity>) {}",
  });
  const findings = structured(result).findings as Array<{ rule: string; resource_type: string }>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "R2");
  assert.equal(findings[0]!.resource_type, "Velocity");
});

await test("validate: fn inside a comment is not a phantom system", async () => {
  const result = await call("bevy_validate_systems", {
    code: "// fn phantom(a: Query<&mut Transform>, b: Query<&Transform>) {}\nfn real(a: Query<&Transform>) {}",
  });
  assert.equal(structured(result).systems_checked, 1);
  assert.equal(structured(result).findings_count, 0);
});

await test("validate: unsupported syntax is reported as not fully analyzed", async () => {
  const result = await call("bevy_validate_systems", { code: "fn f(p: MyCustomSystemParam) {}" });
  const data = structured(result);
  assert.equal(data.analysis_complete, false);
  assert.deepEqual(data.unanalyzed, ["MyCustomSystemParam"]);
});

await test("validate: context input is not advertised", () => {
  const schema = harness.configs.get("bevy_validate_systems")?.inputSchema as Record<string, unknown>;
  assert.ok(schema, "validate_systems has no input schema");
  assert.ok(!("context" in schema), "context is advertised but never read");
});

// --- C-07 / C-09 / C-10 / C-11 / C-12 compatibility --------------------------

await test("compat: caret on 0.0.x does not span the minor line", { todo: "C-07: ^0.0.3 upper bound is computed as 0.1.0" }, () => {
  assert.equal(satisfiesRequirement("^0.0.3", "0.0.3"), true);
  assert.equal(satisfiesRequirement("^0.0.3", "0.0.4"), false);
});

await test("compat: a patch wildcard is honoured", { todo: "C-07: 0.20.* is not parsed" }, () => {
  assert.equal(satisfiesRequirement("0.20.*", "0.20.5"), true);
  assert.equal(satisfiesRequirement("0.20.*", "0.21.0"), false);
});

await test("compat: an unknown Bevy version never yields compatible", { todo: "C-09: no version returns compatible: true" }, async () => {
  const h = await makeHarness({ bevyVersion: null });
  const result = await h.tools.get("bevy_ecosystem_compat")!({ crate: "bevy_egui" });
  assert.notEqual(structured(result).compatible, true);
});

await test("compat: matching plugin versions are returned as candidates", { todo: "C-10: only a boolean is returned" }, async () => {
  const result = await call("bevy_ecosystem_compat", { crate: "bevy_egui" });
  const matching = structured(result).matching_versions as string[];
  assert.ok(Array.isArray(matching), "matching_versions should be an array");
  assert.ok(matching.includes("0.43.1"), "the Bevy 0.20 candidate was not listed");
});

await test("compat: warning references the newest release's requirement", { todo: "C-11: the oldest entry is quoted" }, async () => {
  const h = await makeHarness({ bevyVersion: "0.1.0" });
  const result = await h.tools.get("bevy_ecosystem_compat")!({ crate: "bevy_egui" });
  assert.match(textOf(result), /\^0\.20\.0/);
});

await test("compat: an unsupported requirement is unknown, not incompatible", { todo: "C-08: unsupported operators become a definitive negative" }, async () => {
  const h = await makeHarness({ bevyVersion: "0.21.0" });
  const { server, tools } = captureServer();
  registerEcosystemCompat(server, { config: h.config, compatPath: path.join(FIXTURES, "ecosystem", "compat-edge.json") });
  const result = await tools.get("bevy_ecosystem_compat")!({ crate: "edge_plugin" });
  assert.notEqual(structured(result).compatible, false);
});

await test("compat: the snapshot reports its provenance", { todo: "C-12: no harvest date, source or completeness marker" }, async () => {
  const result = await call("bevy_ecosystem_compat", { crate: "bevy_egui" });
  const provenance = structured(result).provenance as Record<string, unknown> | undefined;
  assert.ok(provenance, "provenance is missing");
  assert.ok(typeof provenance.harvested_at === "string" || typeof provenance.harvested_at === "number");
  assert.equal(typeof provenance.version_count, "number");
});

// --- C-13 / C-14 generator ---------------------------------------------------

await test("generate: system-set template is self-contained", { todo: "C-13: #[system_set] and OtherSystem are undefined" }, async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-with-systemset" });
  const code = String(structured(result).code);
  assert.doesNotMatch(code, /OtherSystem/);
  assert.match(code, /#\[derive\([^\]]*SystemSet/);
});

await test("generate: PLUGIN_NAME changes the emitted plugin", { todo: "C-14a: templates contain no placeholders" }, async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton", params: { PLUGIN_NAME: "FooPlugin" } });
  assert.match(String(structured(result).code), /FooPlugin/);
});

await test("generate: a malformed parameter key does not throw", { todo: "C-14b: RegExp is built from the user key" }, async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton", params: { "a(": "x" } });
  assert.ok(result, "the tool should return a result, not throw");
});

await test("generate: symbol checks are labelled as diagnostics, not compilation", { todo: "C-15: symbol presence is presented as compile safety" }, async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton" });
  assert.equal(structured(result).compile_verified, false);
});

await test("generate: unknown parameters are reported", { todo: "C-14c: unknown keys are silently ignored" }, async () => {
  const result = await call("bevy_generate_plugin", { template: "plugin-skeleton", params: { NOT_A_SLOT: "x" } });
  assert.ok((structured(result).ignored_params as string[]).includes("NOT_A_SLOT"));
});
