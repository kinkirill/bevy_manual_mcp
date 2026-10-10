import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, resolveConfig, detectBevyVersion, detectDocVersion } from "../src/config.js";
import { paginate, completionResult, _internal as pagination } from "../src/pagination.js";
import { VersionRegistry, writeNdjson } from "../src/registry.js";
import type { RustdocRecord } from "../src/types.js";
import { CACHE_VERSION, hybridSearch } from "../src/store.js";
import { createVersionChecker, fetchVersionInfo } from "../src/versions.js";
import { buildRustdocFixture, fixtureConfig, fixtureRecord, fixtureEnv, tempDir, writeFixture, parseObject, errorCode } from "./helpers.mjs";
import { versionArgs, stableVersion, validateOutputTarget } from "../scripts/cli-utils.mjs";
import { readEntry, readRegistry, validateIndex } from "../scripts/index-artifacts.mjs";

await test("setup options work before or after the version and reject missing values", () => {
  const options = { out: { type: "string" as const }, force: { type: "boolean" as const } };
  const first = versionArgs(["--out", "mirror", "--force", "0.20.0"], options);
  const last = versionArgs(["0.20.0", "--force", "--out", "mirror"], options);
  assert.deepEqual(first, last);
  assert.equal(first.version, "0.20.0");
  assert.equal(first.values.out, "mirror");
  assert.equal(first.values.force, true);
  for (const args of [["--out"], ["--out", "--force"], ["--unknown"], ["0.20.0", "0.19.1"]]) {
    assert.throws(() => versionArgs(args, options));
  }
});

await test("setup version validation accepts stable versions and rejects paths or prereleases", () => {
  assert.equal(stableVersion("0.20.0"), "0.20.0");
  for (const version of ["../other", "0.20", "0.20.0-rc.2", "", "--force"]) {
    assert.throws(() => stableVersion(version));
  }
});

await test("setup output validation protects roots and Git checkouts while allowing dedicated directories", () => {
  const root = tempDir();
  try {
    const protectedRoot = path.join(root, "project");
    fs.mkdirSync(protectedRoot);
    const checkout = path.join(root, "checkout");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    for (const target of [root, protectedRoot, os.homedir(), path.parse(root).root, checkout]) {
      assert.throws(() => validateOutputTarget(target, [protectedRoot]));
    }
    assert.equal(validateOutputTarget(path.join(root, "mirror"), [protectedRoot]), path.join(fs.realpathSync(root), "mirror"));
    assert.equal(validateOutputTarget(path.join(protectedRoot, "docs"), [protectedRoot]), path.join(fs.realpathSync(protectedRoot), "docs"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function withEnvironment<T>(values: Record<string, string>, run: () => T): T {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("BEVY_") || key === "INIT_CWD") delete process.env[key];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

await test("compiled configuration locates the package root and vendored website", () => {
  const expected = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(REPO_ROOT, expected);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "package.json")));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "vendor", "bevy-website")));
});

await test("config resolves relative paths at the config file, with environment precedence", () => {
  const root = tempDir("bevy config space-");
  try {
    const configPath = path.join(root, "settings", "config.json");
    const docs = path.join(root, "settings", "docs");
    writeFixture(path.join(docs, "index.html"), "fixture");
    writeFixture(configPath, JSON.stringify({ projectRoot: "..", docDir: "docs", dataDir: "cache", bevyVersion: "9.9.9", offline: true, maxResults: 4 }));
    const resolved = withEnvironment({ BEVY_MCP_CONFIG: configPath }, () => resolveConfig());
    assert.equal(resolved.projectRoot, root);
    assert.equal(resolved.docDir, docs);
    assert.equal(resolved.dataDir, path.join(root, "settings", "cache"));
    assert.equal(resolved.env.offline, true);
    const overridden = withEnvironment({ BEVY_MCP_CONFIG: configPath, BEVY_VERSION: "9.9.8", BEVY_MCP_MAX_RESULTS: "6", BEVY_MCP_DATA_DIR: root }, () => resolveConfig());
    assert.equal(overridden.bevyVersion, "9.9.8");
    assert.equal(overridden.dataDir, root);
    assert.equal(overridden.env.maxResults, 6);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("Cargo.lock wins over Cargo.toml and ordinary dependency strings are detected", () => {
  const root = tempDir();
  try {
    writeFixture(path.join(root, "Cargo.toml"), '[package]\nname = "demo"\nversion = "1.0.0"\n[dependencies]\nbevy = "0.19"\nserde = { version = "1.0" }\n');
    assert.equal(withEnvironment({}, () => detectBevyVersion(root)).version, "0.19");
    writeFixture(path.join(root, "Cargo.lock"), 'version = 4\n[[package]]\nname = "bevy"\nversion = "0.19.1"\n');
    assert.equal(withEnvironment({}, () => detectBevyVersion(root)).version, "0.19.1");
    assert.equal(withEnvironment({ BEVY_VERSION: "0.20.0" }, () => detectBevyVersion(root)).version, "0.20.0");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("unversioned Cargo dependency cannot borrow a neighbouring dependency version", () => {
  const root = tempDir();
  try {
    writeFixture(path.join(root, "Cargo.toml"), '[dependencies]\nbevy = { path = "../bevy" }\nserde = { version = "1.0" }\n');
    assert.equal(withEnvironment({}, () => detectBevyVersion(root)).version, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("normal target/doc layout and doc manifest version are detected", () => {
  const root = tempDir();
  try {
    const docs = path.join(root, "target", "doc");
    writeFixture(path.join(docs, "index.html"), "fixture");
    writeFixture(path.join(docs, ".bevy-mcp-docversion.json"), JSON.stringify({ version: "9.9.9" }));
    assert.equal(detectDocVersion(docs)?.version, "9.9.9");
    const configPath = path.join(root, "config.json");
    writeFixture(configPath, "{}");
    assert.equal(withEnvironment({ BEVY_PROJECT_ROOT: root, BEVY_MCP_CONFIG: configPath }, () => resolveConfig()).docDir, docs);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("pagination visits each record exactly once and finishes without a cursor", () => {
  const input = Array.from({ length: 121 }, (_, index) => index);
  const query = { type: "kind" as const, version: "9.9.9", kind: "fn" };
  const found: number[] = [];
  let cursor: string | undefined;
  do {
    const result = paginate(input, query, cursor);
    found.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(found, input);
  assert.equal(paginate(input, query, undefined, { pageSize: 999 }).pageSize, 200);
});

await test("cursors reject malformed offsets and cannot cross long query identities", () => {
  const query = { type: "owner" as const, version: "9.9.9", owner: "Long".repeat(60) };
  const items = Array.from({ length: 60 }, (_, i) => i);
  const cursor = paginate(items, query).nextCursor;
  assert.ok(cursor);
  assert.throws(() => paginate(items, { ...query, owner: query.owner + "Other" }, cursor), (error: unknown) => errorCode(error) === -32602);
  for (const offset of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const forged = pagination.encode({ q: pagination.fingerprint(query), o: offset });
    assert.throws(() => paginate(items, query, forged), (error: unknown) => errorCode(error) === -32602);
  }
  assert.throws(() => paginate(items, query, "not-json"), (error: unknown) => errorCode(error) === -32602);
});

await test("completion caps values at 100 while retaining total and hasMore", () => {
  const values = Array.from({ length: 130 }, (_, i) => String(i));
  assert.deepEqual(completionResult(values), { values: values.slice(0, 100), total: 130, hasMore: true });
  assert.deepEqual(completionResult(["only"]), { values: ["only"], total: 1, hasMore: false });
});

const versionPayload = {
  crate: { newest_version: "0.20.0-rc.2", max_stable_version: "0.19.1" },
  versions: [
    { num: "0.20.0-rc.2", yanked: false },
    { num: "0.19.1", yanked: false },
    { num: "0.19.0", yanked: false },
    { num: "0.18.1", yanked: true },
  ],
};

await test("production crates.io parser selects stable non-yanked releases", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(versionPayload)));
  const info = await fetchVersionInfo();
  assert.ok(info.ok);
  assert.equal(info.newest_stable, "0.19.1");
  assert.equal(info.preview, "0.20.0-rc.2");
  assert.deepEqual(info.recent, ["0.19.1", "0.19.0"]);
});

await test("version checker is offline-safe, caches successes and preserves stale data", async (t) => {
  let requests = 0;
  let failed = false;
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return failed ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify(versionPayload));
  });
  const offline = await createVersionChecker({ offline: true })();
  assert.equal(offline.ok, false);
  assert.equal(requests, 0);
  const check = createVersionChecker({ ttlMs: 10 });
  const first = await check();
  assert.equal(first.ok, true);
  assert.deepEqual(await check(), first);
  assert.equal(requests, 1);
  now += 11;
  const refreshed = await check();
  assert.equal(refreshed.ok, true);
  assert.equal(requests, 2);
  failed = true;
  const stale = await check({ refresh: true });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.stale, refreshed);
  assert.equal(requests, 3);
});

await test("version fetch reports HTTP failures, invalid JSON and actual timeout aborts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("no", { status: 429 }));
  assert.match((await fetchVersionInfo()).error ?? "", /429/);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("invalid-json"));
  assert.equal((await fetchVersionInfo()).ok, false);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  assert.match((await fetchVersionInfo({ timeoutMs: 5 })).error ?? "", /timed out/);
});

await test("NDJSON write rejects an early filesystem failure without hanging", { timeout: 2_000 }, async () => {
  const root = tempDir();
  try {
    await assert.rejects(writeNdjson(path.join(root, "missing-parent", "records.ndjson"), [fixtureRecord()]), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("downloaded API indexes reject missing or extra records against declared counts", async () => {
  const root = tempDir();
  try {
    const record = fixtureRecord({ source: "rustdoc", kind: "struct", name: "Widget", full_path: "fixture::Widget", bevy_version: "9.9.9" });
    writeFixture(path.join(root, "meta.json"), JSON.stringify({ bevy_version: "9.9.9", cache_version: CACHE_VERSION, api_records: 1 }));
    writeFixture(path.join(root, "text-index.json"), "{}");
    writeFixture(path.join(root, "records.ndjson"), JSON.stringify(record) + "\n");
    await validateIndex(root, "9.9.9");
    for (const count of [0, 2]) {
      writeFixture(path.join(root, "records.ndjson"), (JSON.stringify(record) + "\n").repeat(count));
      await assert.rejects(validateIndex(root, "9.9.9"), new RegExp(`API record count mismatch: expected 1, found ${count}`));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("downloaded API indexes require rustdoc records with the requested version provenance", async () => {
  const root = tempDir();
  try {
    writeFixture(path.join(root, "meta.json"), JSON.stringify({ bevy_version: "9.9.9", cache_version: CACHE_VERSION, api_records: 1 }));
    writeFixture(path.join(root, "text-index.json"), "{}");
    const records = [
      fixtureRecord({ source: "website", bevy_version: "9.9.9" }),
      fixtureRecord({ source: "rustdoc", bevy_version: "9.9.8" }),
      fixtureRecord({ source: "rustdoc" }),
    ];
    for (const record of records) {
      writeFixture(path.join(root, "records.ndjson"), JSON.stringify(record) + "\n");
      await assert.rejects(validateIndex(root, "9.9.9"), /Index records must be rustdoc for Bevy 9\.9\.9/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("artifact entry readers preserve optional metadata and reject invalid record counts", () => {
  const root = tempDir();
  try {
    const entryFile = path.join(root, "entry.json");
    const registryFile = path.join(root, "registry.json");
    const minimal = { version: "9.9.9", cache_version: CACHE_VERSION };
    const detailed = {
      ...minimal, records: 1, symbols: 1, built_at: "2026-10-10T00:00:00.000Z",
      by_kind: { struct: 1 }, doc_dir: null, artifact_source: "fixture",
    };
    for (const entry of [minimal, detailed]) {
      writeFixture(entryFile, JSON.stringify(entry));
      writeFixture(registryFile, JSON.stringify({ cache_version: CACHE_VERSION, versions: { "9.9.9": entry } }));
      assert.deepEqual(readEntry(entryFile, "9.9.9"), entry);
      assert.deepEqual(readRegistry(root).versions["9.9.9"], entry);
    }
    const malformed = { ...detailed, records: "bad" };
    writeFixture(entryFile, JSON.stringify(malformed));
    writeFixture(registryFile, JSON.stringify({ cache_version: CACHE_VERSION, versions: { "9.9.9": malformed } }));
    assert.throws(() => readEntry(entryFile, "9.9.9"));
    assert.throws(() => readRegistry(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("documentation source version mismatch is rejected before indexing", async () => {
  const root = tempDir();
  try {
    const docs = path.join(root, "docs");
    writeFixture(path.join(docs, ".bevy-mcp-docversion.json"), JSON.stringify({ version: "9.9.8" }));
    const registry = new VersionRegistry(fixtureConfig(root, { docDir: docs }));
    assert.throws(() => registry.registerSource("9.9.7", docs), /version mismatch/i);
    assert.equal(registry.has("9.9.7"), false);
    await assert.rejects(registry.get("9.9.9"), /version mismatch/i);
    assert.equal(fs.existsSync(registry.dirFor("9.9.9")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("docs setup refuses to resume a mirror belonging to another version", () => {
  const root = tempDir();
  try {
    const mirror = path.join(root, "mirror");
    const manifest = path.join(mirror, ".bevy-mcp-docversion.json");
    writeFixture(manifest, JSON.stringify({ version: "8.8.8" }));
    const before = fs.readFileSync(manifest, "utf8");
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "build", "scripts", "fetch-docs.mjs"), "--out", mirror, "9.9.9"], {
      cwd: root, env: fixtureEnv(root, path.join(root, "data")), encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /version|belongs|mismatch/i);
    assert.equal(fs.readFileSync(manifest, "utf8"), before);
    assert.deepEqual(fs.readdirSync(mirror), [".bevy-mcp-docversion.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await test("warm supplemental search tracks edits, additions and removals", async () => {
  const root = tempDir();
  try {
    const website = path.join(root, "website");
    const edited = path.join(website, "content", "learn", "book", "older.md");
    const newest = path.join(website, "content", "learn", "book", "newer.md");
    const added = path.join(website, "content", "learn", "book", "added.md");
    writeFixture(edited, "# Older chapter\noldgalacticwidget systems demonstrate deterministic engine scheduling behavior.\n");
    writeFixture(newest, "# Newer chapter\nsteadygalacticwidget systems demonstrate deterministic engine scheduling behavior.\n");
    fs.utimesSync(edited, new Date("2020-01-01"), new Date("2020-01-01"));
    fs.utimesSync(newest, new Date("2030-01-01"), new Date("2030-01-01"));
    const config = fixtureConfig(root, { websiteDir: website });
    const cold = await new VersionRegistry(config).get("9.9.9");
    assert.ok(hybridSearch(cold, "oldgalacticwidget").length);
    writeFixture(edited, "# Older chapter\ncurrentgalacticwidget systems demonstrate updated engine scheduling behavior and documentation.\n");
    fs.utimesSync(edited, new Date("2020-01-02"), new Date("2020-01-02"));
    const changed = await new VersionRegistry(config).get("9.9.9");
    assert.ok(hybridSearch(changed, "currentgalacticwidget").length);
    assert.equal(hybridSearch(changed, "oldgalacticwidget").length, 0);
    writeFixture(added, "# Added chapter\naddedgalacticwidget systems demonstrate newly introduced engine scheduling behavior.\n");
    const expanded = await new VersionRegistry(config).get("9.9.9");
    assert.ok(hybridSearch(expanded, "addedgalacticwidget").length);
    fs.rmSync(edited);
    const removed = await new VersionRegistry(config).get("9.9.9");
    assert.equal(hybridSearch(removed, "currentgalacticwidget").length, 0);
    assert.ok(hybridSearch(removed, "addedgalacticwidget").length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const ownFixture = !process.env.RESOURCE_FIXTURE_DIR;
const fixtureRoot = process.env.RESOURCE_FIXTURE_DIR ?? tempDir();
const docDir = ownFixture ? buildRustdocFixture(fixtureRoot) : path.join(fixtureRoot, "rdfixture", "target", "doc");
try {
  await test("concurrent version loads share one index and one rustdoc ingest", async () => {
    const root = tempDir();
    try {
      let ingests = 0;
      class CountingRegistry extends VersionRegistry {
        override *versionedRustdoc(directory: string, version: string): Generator<RustdocRecord> {
          ingests++;
          yield* super.versionedRustdoc(directory, version);
        }
      }
      const registry = new CountingRegistry(fixtureConfig(root, { docDir }));
      const [first, second, third] = await Promise.all([registry.get("9.9.9"), registry.get("9.9.9"), registry.get("9.9.9")]);
      assert.equal(first, second);
      assert.equal(second, third);
      assert.equal(ingests, 1);
      assert.ok(first?.lookupSymbol("Widget::new").length);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test("failed registry commit rolls back every prior cache artifact and registry entry", async () => {
    const root = tempDir();
    try {
      const config = fixtureConfig(root, { docDir });
      const established = new VersionRegistry(config);
      await established.get("9.9.9");
      const files = ["records.ndjson", "meta.json", "text-index.json"].map((name) => path.join(established.dirFor("9.9.9"), name));
      files.push(path.join(config.dataDir, "registry.json"));
      const before = files.map((file) => fs.readFileSync(file));
      class FailingRegistry extends VersionRegistry {
        override writeRegistry(): void { throw new Error("Injected registry write failure"); }
      }
      const registry = new FailingRegistry(config);
      const previousEntry = structuredClone(registry.registry);
      await assert.rejects(registry.get("9.9.9", { force: true }), /Injected registry write failure/);
      assert.deepEqual(registry.registry, previousEntry);
      for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]!), before[i]);
      assert.deepEqual(fs.readdirSync(registry.root), ["9.9.9"]);
      const website = path.join(root, "website");
      writeFixture(path.join(website, "content", "learn", "book", "fresh.md"), "# Fresh chapter\nfreshgalacticwidget explains deterministic scheduling behavior with updated supplemental documentation.\n");
      const refreshing = new FailingRegistry({ ...config, websiteDir: website });
      const fresh = await refreshing.get("9.9.9");
      assert.ok(hybridSearch(fresh, "freshgalacticwidget").length, "Cache write failure must retain fresh in-memory search");
      assert.deepEqual(refreshing.registry, previousEntry);
      for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]!), before[i]);
      assert.deepEqual(fs.readdirSync(refreshing.root), ["9.9.9"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("warm registry reload retains website, engine examples and search results", async () => {
    const root = tempDir();
    try {
      const website = path.join(root, "website");
      const examples = path.join(root, "examples");
      writeFixture(path.join(website, "content", "learn", "book", "scheduling.md"), "# System ordering\nSystems run in dependency order and can be configured using schedules.\n");
      writeFixture(path.join(examples, "2d", "widgets.rs"), "//! Render widgets in two dimensions.\nfn main() { println!(\"widget\"); }\n");
      const config = fixtureConfig(root, { docDir, websiteDir: website, examplesDir: examples });
      const cold = await new VersionRegistry(config).get("9.9.9");
      const warm = await new VersionRegistry(config).get("9.9.9");
      assert.deepEqual(warm.records, cold.records);
      assert.ok(warm.records.some((record) => record.source === "website"));
      assert.ok(warm.records.some((record) => record.source === "bevy-examples"));
      assert.deepEqual(hybridSearch(warm, "system ordering").map((hit) => hit.record.full_path), hybridSearch(cold, "system ordering").map((hit) => hit.record.full_path));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test("old and unknown cache formats rebuild instead of reading stale records", async () => {
    const root = tempDir();
    try {
      const config = fixtureConfig(root, { docDir });
      for (const cacheVersion of [CACHE_VERSION - 1, undefined]) {
        const registry = new VersionRegistry(config);
        await registry.get("9.9.9", { force: true });
        const metaPath = path.join(registry.dirFor("9.9.9"), "meta.json");
        const meta = parseObject(fs.readFileSync(metaPath, "utf8"));
        const persisted = parseObject(fs.readFileSync(path.join(config.dataDir, "registry.json"), "utf8"));
        assert.ok(typeof persisted.versions === "object" && persisted.versions !== null);
        const entries = persisted.versions as Record<string, unknown>;
        const entry = entries["9.9.9"];
        assert.ok(typeof entry === "object" && entry !== null);
        if (cacheVersion === undefined) {
          delete meta.cache_version;
          delete (entry as Record<string, unknown>).cache_version;
        } else {
          meta.cache_version = cacheVersion;
          (entry as Record<string, unknown>).cache_version = cacheVersion;
        }
        fs.writeFileSync(metaPath, JSON.stringify(meta));
        fs.writeFileSync(path.join(config.dataDir, "registry.json"), JSON.stringify(persisted));
        fs.writeFileSync(path.join(registry.dirFor("9.9.9"), "records.ndjson"), "stale garbage\n");
        const rebuilt = await new VersionRegistry(config).get("9.9.9");
        assert.ok(rebuilt.lookupSymbol("Widget::new").length);
        assert.ok(rebuilt.meta);
        assert.equal(rebuilt.meta.cache_version, CACHE_VERSION);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test("version registry isolates identical symbols and refuses unknown historical sources", async () => {
    const root = tempDir();
    try {
      const historical = path.join(root, "old-docs");
      fs.cpSync(docDir, historical, { recursive: true });
      const page = path.join(historical, "rdfixture", "struct.Widget.html");
      fs.writeFileSync(page, fs.readFileSync(page, "utf8").replaceAll("u32", "u64"));
      const registry = new VersionRegistry(fixtureConfig(root, { docDir }));
      registry.registerSource("9.9.8", historical);
      const current = await registry.get("9.9.9");
      const previous = await registry.get("9.9.8");
      assert.match(current.lookupSymbol("Widget::id")[0]!.record.signature, /u32/);
      assert.match(previous.lookupSymbol("Widget::id")[0]!.record.signature, /u64/);
      assert.ok(current.records.filter((record) => record.source === "rustdoc").every((record) => record.bevy_version === "9.9.9"));
      assert.ok(previous.records.filter((record) => record.source === "rustdoc").every((record) => record.bevy_version === "9.9.8"));
      await assert.rejects(registry.get("1.2.3"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test("source-less v5 tuple-field caches load without numeric symbols and still detect torn counts", async () => {
    const root = tempDir();
    try {
      const docs = path.join(root, "docs");
      fs.cpSync(docDir, docs, { recursive: true });
      const config = fixtureConfig(root, { docDir: docs });
      const registry = new VersionRegistry(config);
      const original = await registry.get("9.9.9");
      const tuple = original.records.find((record) => record.kind === "struct" && record.name === "TupleWidget");
      assert.ok(tuple, "fixture must contain a genuine tuple struct");
      const numeric = fixtureRecord({
        source: "rustdoc", kind: "field", name: "0", full_path: "rdfixture::TupleWidget::0",
        owner: "TupleWidget", module: "rdfixture", file: tuple.file, signature: "0: u32",
        bevy_version: "9.9.9", id: "legacy-tuple-field",
      });
      const recordsPath = path.join(registry.dirFor("9.9.9"), "records.ndjson");
      const metaPath = path.join(registry.dirFor("9.9.9"), "meta.json");
      const meta = parseObject(fs.readFileSync(metaPath, "utf8"));
      assert.equal(meta.cache_version, CACHE_VERSION);
      assert.ok(typeof meta.api_records === "number");
      const originalCount = meta.api_records;
      fs.appendFileSync(recordsPath, JSON.stringify(numeric) + "\n");
      meta.api_records = originalCount + 1;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      fs.rmSync(docs, { recursive: true, force: true });
      const loaded = await new VersionRegistry({ ...config, docDir: null }).get("9.9.9");
      // API resources read this collection: only the legacy numeric row is omitted.
      assert.deepEqual(loaded.records, original.records);
      assert.ok(loaded.lookupSymbol("Widget::label").some((hit) => hit.record.kind === "field"));
      assert.match(loaded.lookupSymbol("TupleWidget")[0]!.record.signature, /pub struct TupleWidget\s*\(/);
      assert.equal(loaded.lookupSymbol("0").length, 0);
      assert.equal(loaded.lookupSymbol(numeric.full_path).length, 0);
      assert.equal(loaded.byId.has("legacy-tuple-field"), false);
      // A count equal to admitted records is still torn against the raw bundle rows.
      meta.api_records = originalCount;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      const files = [recordsPath, metaPath, path.join(config.dataDir, "registry.json")];
      const before = files.map((file) => fs.readFileSync(file));
      await assert.rejects(new VersionRegistry({ ...config, docDir: null }).get("9.9.9"));
      for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]!), before[i]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test("current source-less API cache loads and stale source-less cache stays recoverable", async () => {
    const root = tempDir();
    try {
      const docs = path.join(root, "docs");
      fs.cpSync(docDir, docs, { recursive: true });
      const config = fixtureConfig(root, { docDir: docs });
      const registry = new VersionRegistry(config);
      const original = await registry.get("9.9.9");
      fs.rmSync(docs, { recursive: true, force: true });
      const loaded = await new VersionRegistry({ ...config, docDir: null }).get("9.9.9");
      assert.deepEqual(loaded.records, original.records);
      assert.ok(loaded.lookupSymbol("Widget::new").length);
      const metaPath = path.join(registry.dirFor("9.9.9"), "meta.json");
      const meta = parseObject(fs.readFileSync(metaPath, "utf8"));
      meta.cache_version = CACHE_VERSION - 1;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      const persisted = parseObject(fs.readFileSync(path.join(config.dataDir, "registry.json"), "utf8"));
      assert.ok(typeof persisted.versions === "object" && persisted.versions !== null);
      const entry = (persisted.versions as Record<string, unknown>)["9.9.9"];
      assert.ok(typeof entry === "object" && entry !== null);
      (entry as Record<string, unknown>).cache_version = CACHE_VERSION - 1;
      fs.writeFileSync(path.join(config.dataDir, "registry.json"), JSON.stringify(persisted));
      const recordsPath = path.join(registry.dirFor("9.9.9"), "records.ndjson");
      const records = fs.readFileSync(recordsPath, "utf8");
      await assert.rejects(new VersionRegistry({ ...config, docDir: null }).get("9.9.9"));
      assert.equal(fs.readFileSync(recordsPath, "utf8"), records);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
} finally {
  if (ownFixture) fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
