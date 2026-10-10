#!/usr/bin/env node
// Run each corpus in a separate process to release its index before the next.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createBevyServer } from "../server.js";
import { PACKAGE_ROOT, resolveConfig } from "../src/config.js";
import { apiUri } from "../src/resources.js";
import { errorMessage, type IndexedRecord, type IndexStats, type ResolvedConfig } from "../src/types.js";
import { stableVersion } from "../scripts/cli-utils.mjs";

const DEFAULT_VERSIONS = ["0.15.3", "0.16.1", "0.17.3", "0.18.1", "0.19.1", "0.20.0"];
const ECS_TYPES = ["Event", "EventReader", "EventWriter", "Events", "Message", "MessageReader", "MessageWriter", "Messages"];
const EVENT_BUFFERED = new Set(["EventReader", "EventWriter", "Events"]);
const MESSAGE_BUFFERED = new Set(["MessageReader", "MessageWriter", "Messages"]);
type Topic = "sphere" | "mesh" | "material" | "communication" | "message" | "comparison";
interface Question { id: string; query: string; topic: Topic; action?: "read" | "write" }
const QUESTIONS: Question[] = [
  { id: "user-sphere", query: "How to spawn a sphere", topic: "sphere" },
  { id: "user-comparison", query: "Difference between message and event", topic: "comparison" },
  { id: "sphere-radius", query: "How do I create a 3D sphere with a given radius?", topic: "sphere" },
  { id: "sphere-scene", query: "How do I spawn a sphere in a 3D scene?", topic: "sphere" },
  { id: "sphere-material", query: "How do I create a sphere with a red material?", topic: "material" },
  { id: "sphere-mesh", query: "How do I turn a sphere into a mesh?", topic: "mesh" },
  { id: "send-events", query: "How do I send events between systems?", topic: "communication", action: "write" },
  { id: "read-events", query: "How can a system read events?", topic: "communication", action: "read" },
  { id: "send-messages", query: "How do I send messages between systems?", topic: "message", action: "write" },
  { id: "read-messages", query: "How can a system read messages?", topic: "message", action: "read" },
  { id: "communicate", query: "How do I communicate between systems?", topic: "communication" },
];

interface Check { name: string; passed: boolean; detail: string }
interface Capability { available: boolean; paths: string[]; resource_uris: string[] }
interface Hit {
  rank: number; source: string; kind: string; name: string; full_path: string;
  signature: string; bevy_version: string | null; source_ref: string | null;
  docs: string; examples: string[]; from_version: string | null; to_version: string | null;
  file: string; line_start: number | null; heading: string | null;
}
interface QuestionResult {
  id: string; query: string; status: "passed" | "failed" | "unavailable";
  detail: string; hits: Hit[]; response_excerpt: string;
}
interface VersionReport {
  version: string; passed: boolean; elapsed_ms: number; records: number;
  website_dir: string; checks: Check[]; capabilities: Record<string, Capability>;
  questions: QuestionResult[]; error?: string;
  meta: { cache_version: number | null; api_records: number | null; built_at: string | null; text_indexed: number | null };
  stats: IndexStats;
  content: { records_with_examples: number; api_records_with_examples: number; api_code_snippets: number; code_example_records: number };
}

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;
const searchSchema = z.object({
  queried_version: z.string(), version_indexed: z.boolean(),
  results: z.array(z.object({
    source: z.string(), kind: z.string(), name: z.string(), full_path: z.string(),
    signature: z.string().optional(), file: z.string().optional(), line_start: z.number().optional(),
    heading: z.string().optional(), doc_excerpt: z.string().optional(),
  }).passthrough()),
}).passthrough();
const apiSchema = z.object({ bevy_version: z.string(), version_indexed: z.boolean(), symbol: z.string(), signature: z.string() }).passthrough();
type StructuredHit = z.infer<typeof searchSchema>["results"][number];

function matchHit(candidates: IndexedRecord[] | undefined, hit: StructuredHit): IndexedRecord {
  const matches = (candidates ?? []).filter((record) =>
    record.source === hit.source && record.kind === hit.kind && record.name === hit.name &&
    (hit.signature === undefined || record.signature === hit.signature) &&
    (hit.file === undefined || record.file === hit.file) &&
    (hit.line_start === undefined || record.line_start === hit.line_start) &&
    (hit.heading === undefined || record.heading === hit.heading),
  );
  const excerpt = hit.doc_excerpt;
  const described = excerpt === undefined ? matches : matches.filter((record) => {
    const docs = record.docs.replace(/\s+/g, " ");
    return excerpt.endsWith(" …") ? docs.startsWith(excerpt.slice(0, -2)) : docs === excerpt;
  });
  assert.ok(described.length, `No corpus record matches the structured MCP hit ${hit.full_path} (${hit.heading ?? hit.name})`);
  // Identical serialized hits are indistinguishable without an MCP record id.
  return described[0]!;
}

function toolText(result: ToolResponse): string {
  if (!Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    const parsed = z.object({ type: z.literal("text"), text: z.string() }).safeParse(block);
    return parsed.success ? [parsed.data.text] : [];
  }).join("\n");
}
function leaf(value: string): string { return value.replace(/<.*$/, "").trim(); }
function isEcs(record: IndexedRecord): boolean {
  return record.source === "rustdoc" && (/^bevy::ecs::/.test(record.full_path) || /docs\.rs\/bevy_ecs\//.test(record.source_ref ?? ""));
}
function isGeometry(record: IndexedRecord): boolean {
  if (record.source !== "rustdoc") return false;
  const subject = leaf(record.owner ?? record.name);
  if (!["Sphere", "SphereMeshBuilder"].includes(subject)) return false;
  return /::(?:math::primitives|shape)(?:::|$)/.test(record.full_path) ||
    /docs\.rs\/(?:bevy_math|bevy_shape)\//.test(record.source_ref ?? "") ||
    subject === "SphereMeshBuilder";
}
function canonical(records: IndexedRecord[]): IndexedRecord | undefined {
  return records.slice().sort((a, b) =>
    Number(a.full_path.includes("::prelude::")) - Number(b.full_path.includes("::prelude::")) ||
    a.full_path.length - b.full_path.length || a.full_path.localeCompare(b.full_path),
  )[0];
}
function hitReport(record: IndexedRecord, rank: number): Hit {
  return {
    rank, source: record.source, kind: record.kind, name: record.name, full_path: record.full_path,
    signature: record.signature, bevy_version: record.bevy_version ?? null, source_ref: record.source_ref ?? null,
    docs: record.docs.slice(0, 1_200), examples: [...(record.code ? [record.code] : []), ...(record.examples ?? []).map((example) => example.code)].slice(0, 2).map((code) => code.slice(0, 1_200)),
    from_version: record.from_version ?? null, to_version: record.to_version ?? null,
    file: record.file, line_start: record.line_start ?? null, heading: record.heading ?? null,
  };
}

function assess(question: Question, records: IndexedRecord[], capabilities: Record<string, Capability>): Pick<QuestionResult, "status" | "detail"> {
  const hasMessage = capabilities.Message?.available === true;
  const relevantProse = (record: IndexedRecord, words: string[]) => record.source !== "rustdoc" &&
    words.every((word) => new RegExp(`\\b(?:${word})\\b`, "i").test(`${record.name} ${record.docs}`));
  const family = (record: IndexedRecord) => leaf(record.owner ?? record.name);
  const buffered = (record: IndexedRecord) => {
    if (!isEcs(record)) return false;
    const symbol = family(record);
    if (question.action === "write" &&
        ((record.kind === "method" && ["Commands", "World", "DeferredWorld"].includes(symbol)) ||
         (record.kind === "fn" && record.full_path.includes("::ecs::system::command::"))) &&
        /^(?:send_event|write_message)(?:_(?:batch|default))?$/.test(record.name)) return true;
    const wanted = question.action === "read" ? ["EventReader", "Events", "MessageReader", "Messages"]
      : question.action === "write" ? ["EventWriter", "Events", "MessageWriter", "Messages"]
      : [...EVENT_BUFFERED, ...MESSAGE_BUFFERED];
    return wanted.includes(symbol);
  };
  let relevant: boolean;
  switch (question.topic) {
    case "sphere":
      relevant = records.some(isGeometry) || records.some((record) => relevantProse(record, ["sphere", "spawn|radius|mesh"]));
      break;
    case "mesh":
      relevant = records.some((record) => isGeometry(record) || (record.source === "rustdoc" && /SphereMeshBuilder/.test(record.name))) ||
        records.some((record) => relevantProse(record, ["sphere", "mesh"]));
      break;
    case "material":
      relevant = records.some((record) => record.source === "rustdoc" &&
        ((["struct", "type"].includes(record.kind) && ["StandardMaterial", "MeshMaterial3d"].includes(leaf(record.name))) ||
         (record.kind === "field" && record.name === "base_color" && leaf(record.owner ?? "") === "StandardMaterial"))) ||
        records.some((record) => {
          const snippets = [...(record.code ? [record.code] : []), ...(record.examples ?? []).map((example) => example.code)];
          return snippets.some((code) => /\bSphere\b/.test(code) && /\b(?:[A-Za-z]*Material[0-9a-z]*|material|base_color|Color|color)\b/.test(code));
        });
      break;
    case "communication":
      relevant = records.some(buffered) || records.some((record) => relevantProse(record, ["events?|messages?", "systems?"]));
      break;
    case "message":
      if (!hasMessage) return { status: "unavailable", detail: "This corpus has no ECS Message API; related suggestions do not establish its availability." };
      relevant = records.some((record) => buffered(record) && MESSAGE_BUFFERED.has(family(record))) ||
        records.some((record) => relevantProse(record, ["messages?", "systems?"]));
      break;
    case "comparison":
      if (!hasMessage) {
        relevant = records.some((record) => isEcs(record) && /^(?:Event|EventReader|EventWriter|Events)$/.test(leaf(record.name))) ||
          records.some((record) => relevantProse(record, ["events?"]));
      } else {
        const ecs = records.filter(isEcs);
        relevant = ecs.some((record) => /\bmessages?\b/i.test(record.docs) && /\bevents?\b/i.test(record.docs)) ||
          (ecs.some((record) => /^Message/.test(leaf(record.name))) && ecs.some((record) => /^Event/.test(leaf(record.name)))) ||
          records.some((record) => relevantProse(record, ["messages?", "events?"]));
      }
      break;
  }
  return {
    status: relevant ? "passed" : "failed",
    detail: relevant ? `Relevant ${question.topic} material appears in the default eight results${!hasMessage && question.topic === "comparison" ? "; ECS Message is absent in this release" : ""}.`
      : `No relevant ${question.topic} material in the default eight results.`,
  };
}

async function runVersion(version: string, dataDir: string): Promise<VersionReport> {
  const started = Date.now();
  const websiteDir = path.join(PACKAGE_ROOT, "vendor", "bevy-website");
  const report: VersionReport = {
    version, passed: false, elapsed_ms: 0, records: 0, website_dir: websiteDir, checks: [], capabilities: {}, questions: [],
    meta: { cache_version: null, api_records: null, built_at: null, text_indexed: null },
    stats: { total: 0, by_source: {}, by_kind: {} },
    content: { records_with_examples: 0, api_records_with_examples: 0, api_code_snippets: 0, code_example_records: 0 },
  };
  const config: ResolvedConfig = {
    ...resolveConfig({ env: {}, projectRoot: PACKAGE_ROOT, bevyVersion: version }),
    configPath: null, versionSource: "corpus harness", dataDir, docDir: null, docVersion: null, docVersionSource: null,
    websiteDir, examplesDir: null, bevySrcDir: null, errorsDir: null, env: { offline: true, debug: false, maxResults: 8 },
  };
  const client = new Client({ name: "bevy-corpus-questions", version: "1.0.0" });
  let runtime: Awaited<ReturnType<typeof createBevyServer>> | undefined;
  async function check(name: string, run: () => void | Promise<void>): Promise<void> {
    try { await run(); report.checks.push({ name, passed: true, detail: "passed" }); }
    catch (error) { report.checks.push({ name, passed: false, detail: errorMessage(error) }); }
  }
  try {
    runtime = await createBevyServer(config, { force: false, extraVersions: "" });
    const { server, index } = runtime;
    report.records = index.records.length;
    report.meta = {
      cache_version: index.meta?.cache_version ?? null, api_records: index.meta?.api_records ?? null,
      built_at: index.meta?.built_at ?? null, text_indexed: index.meta?.text_indexed ?? null,
    };
    report.stats = { total: index.stats.total, by_source: { ...index.stats.by_source }, by_kind: { ...index.stats.by_kind } };
    report.content = {
      records_with_examples: index.records.filter((record) => record.examples?.length).length,
      api_records_with_examples: index.records.filter((record) => record.source === "rustdoc" && record.examples?.length).length,
      api_code_snippets: index.records.reduce((total, record) => total + (record.source === "rustdoc" ? record.examples?.length ?? 0 : 0), 0),
      code_example_records: index.records.filter((record) => record.kind === "code_example").length,
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport, { timeout: 30_000 });
    await check("full published API and bundled website provenance", () => {
      assert.ok(index.records.filter((record) => record.source === "rustdoc").length > 1_000, "API corpus is missing or only a fixture");
      assert.ok(index.records.some((record) => record.source === "website"), "Bundled website prose is missing");
      assert.ok(index.records.filter((record) => record.source === "rustdoc" || record.source === "bevy-examples").every((record) => record.bevy_version === version));
    });
    const byPath = new Map<string, IndexedRecord[]>();
    for (const record of index.records) {
      const candidates = byPath.get(record.full_path);
      if (candidates) candidates.push(record);
      else byPath.set(record.full_path, [record]);
    }
    for (const symbol of ECS_TYPES) {
      const records = index.records.filter((record) => isEcs(record) && leaf(record.name) === symbol && ["struct", "enum", "trait", "type"].includes(record.kind));
      report.capabilities[symbol] = { available: records.length > 0, paths: records.map((record) => record.full_path), resource_uris: records.map((record) => apiUri(version, record.full_path)) };
    }
    await check("buffered ECS communication API exists", () => {
      assert.ok([...EVENT_BUFFERED, ...MESSAGE_BUFFERED].some((symbol) => report.capabilities[symbol]?.available));
    });
    if (/^0\.(?:15|16)\./.test(version)) {
      await check("Message API is absent in 0.15 and 0.16", () => {
        for (const symbol of ["Message", ...MESSAGE_BUFFERED]) assert.equal(report.capabilities[symbol]?.available, false, symbol);
      });
    }
    if (/^0\.(?:17|18|19|20)\./.test(version)) {
      await check("Message API is available in 0.17 and later", () => {
        for (const symbol of ["Message", ...MESSAGE_BUFFERED]) assert.equal(report.capabilities[symbol]?.available, true, symbol);
      });
    }
    async function verifyApi(label: string, record: IndexedRecord | undefined): Promise<void> {
      await check(`${label}: exact MCP lookup and resource read`, async () => {
        assert.ok(record, `Missing ${label} in published API corpus`);
        const result = await client.callTool({ name: "bevy_api", arguments: { symbol: record.full_path, version, include_related: false } });
        assert.notEqual(result.isError, true, toolText(result));
        const api = apiSchema.parse(result.structuredContent);
        assert.equal(api.bevy_version, version);
        assert.equal(api.version_indexed, true);
        assert.equal(api.symbol, record.full_path);
        assert.equal(api.signature, record.signature);
        const resource = await client.readResource({ uri: apiUri(version, record.full_path) });
        const text = resource.contents.flatMap((content) => "text" in content ? [content.text] : []).join("\n");
        assert.ok(text.includes(record.full_path), "Resource omitted requested API path");
        assert.ok(text.includes(record.signature), "Resource omitted real API declaration");
      });
    }
    for (const symbol of ECS_TYPES) {
      if (!report.capabilities[symbol]?.available) continue;
      await verifyApi(symbol, canonical(index.records.filter((record) => isEcs(record) && leaf(record.name) === symbol && ["struct", "enum", "trait", "type"].includes(record.kind))));
    }
    if (!report.capabilities.Message?.available) {
      await check("absent Message resource cannot resolve", async () => {
        await assert.rejects(client.readResource({ uri: apiUri(version, "bevy::ecs::message::Message") }),
          (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
      });
    }
    await verifyApi("geometry Sphere::new", canonical(index.records.filter((record) => isGeometry(record) && leaf(record.owner ?? "") === "Sphere" && record.name === "new")));
    await verifyApi("Commands::spawn", canonical(index.records.filter((record) => isEcs(record) && leaf(record.owner ?? "") === "Commands" && record.name === "spawn")));
    await verifyApi("Mesh3d", canonical(index.records.filter((record) => record.source === "rustdoc" && record.kind === "struct" && record.name === "Mesh3d")));
    for (const question of QUESTIONS) {
      try {
        // Omit limit to test the default search results.
        const result = await client.callTool({ name: "bevy_search", arguments: { query: question.query, version } });
        assert.notEqual(result.isError, true, toolText(result));
        const search = searchSchema.parse(result.structuredContent);
        assert.equal(search.queried_version, version);
        assert.equal(search.version_indexed, true);
        assert.ok(search.results.length <= 8);
        const records = search.results.map((hit) => {
          const record = matchHit(byPath.get(hit.full_path), hit);
          if (record.source === "rustdoc" || record.source === "bevy-examples") assert.equal(record.bevy_version, version);
          return record;
        });
        report.questions.push({ ...question, ...assess(question, records, report.capabilities), hits: records.map((record, rank) => hitReport(record, rank + 1)), response_excerpt: toolText(result).slice(0, 3_000) });
      } catch (error) {
        report.questions.push({ id: question.id, query: question.query, status: "failed", detail: errorMessage(error), hits: [], response_excerpt: "" });
      }
    }
    report.passed = report.checks.every((item) => item.passed) && report.questions.every((item) => item.status !== "failed");
  } catch (error) { report.error = errorMessage(error); }
  finally {
    await client.close().catch(() => undefined);
    await runtime?.server.close().catch(() => undefined);
    runtime?.registry.indices.clear();
    report.elapsed_ms = Date.now() - started;
  }
  return report;
}

async function worker(version: string, dataDir: string): Promise<Record<string, unknown>> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--worker", "--data", dataDir, version], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    const timeout = setTimeout(() => child.kill(), 180_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) { reject(new Error(`${version} worker terminated by ${signal}`)); return; }
      try {
        const report = z.object({ version: z.literal(version), passed: z.boolean() }).passthrough().parse(JSON.parse(stdout));
        if (code !== 0 && report.passed) throw new Error(`${version} worker exited ${code} despite a passing report`);
        resolve(report);
      } catch (error) { reject(new Error(`${version} worker did not produce a valid report: ${errorMessage(error)}`)); }
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: { data: { type: "string" }, out: { type: "string" }, worker: { type: "boolean" }, help: { type: "boolean" } } });
  if (args.values.help) {
    console.log("Usage: node test/corpus-questions.mjs [version ...] [--data registry-directory] [--out report.json]\n" +
      "Optional offline MCP questions against installed published API indexes and the bundled website.\n" +
      `Defaults: ${DEFAULT_VERSIONS.join(" ")}; report: data/corpus-questions.json. Semantic failures exit nonzero.`);
    return;
  }
  const versions = [...new Set((args.positionals.length ? args.positionals : DEFAULT_VERSIONS).map(stableVersion))];
  const dataDir = path.resolve(args.values.data ?? path.join(PACKAGE_ROOT, "data"));
  if (args.values.worker) {
    assert.equal(versions.length, 1, "Worker requires exactly one version");
    const report = await runVersion(versions[0]!, dataDir);
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
    return;
  }
  const reports: Record<string, unknown>[] = [];
  for (const version of versions) {
    console.error(`Checking corpus questions for Bevy ${version}...`);
    try { reports.push(await worker(version, dataDir)); }
    catch (error) { reports.push({ version, passed: false, error: errorMessage(error) }); }
  }
  const passed = reports.every((report) => report.passed === true);
  const output = path.resolve(args.values.out ?? path.join(PACKAGE_ROOT, "data", "corpus-questions.json"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ generated_at: new Date().toISOString(), data_dir: dataDir, passed, versions: reports }, null, 2) + "\n");
  console.error(`Wrote ${output}; ${reports.filter((report) => report.passed === true).length}/${reports.length} versions passed.`);
  process.exitCode = passed ? 0 : 1;
}

await main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
