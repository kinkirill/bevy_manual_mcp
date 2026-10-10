import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { BevyIndex, CACHE_VERSION, exportTextIndex } from "../src/store.js";
import { REPO_ROOT, fixtureRecord, parseObject, tempDir, writeFixture } from "./helpers.mjs";

const version = "9.9.9";
const root = tempDir("bevy fetch recheck space-");
const workingDirectory = path.join(root, "unrelated game with spaces");
fs.mkdirSync(workingDirectory);
const configFile = path.join(root, "offline-config.json");
writeFixture(configFile, JSON.stringify({ offline: true, websiteDir: path.join(root, "no-website") }));
const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith("BEVY_") || key === "INIT_CWD") delete environment[key];
environment.BEVY_MCP_CONFIG = configFile;

const record = fixtureRecord({ source: "rustdoc", kind: "struct", name: "RecheckWidget",
  full_path: "bevy::RecheckWidget", module: "bevy", file: "bevy/struct.RecheckWidget.html",
  signature: "pub struct RecheckWidget;", docs: "A deterministic index download fixture.", bevy_version: version });
const index = new BevyIndex();
index.addRecords([record]);
await index.buildTextIndex();
assert.ok(index.text);
const records = JSON.stringify(record) + "\n";
const text = JSON.stringify(exportTextIndex(index.text));

function metadata(cacheVersion: number | undefined, builtAt: string, count = 1): string {
  return JSON.stringify({ bevy_version: version, cache_version: cacheVersion, built_at: builtAt, api_records: count });
}

function entry(cacheVersion: number | undefined, builtAt: string) {
  return { version, cache_version: cacheVersion, built_at: builtAt, records: 1 };
}

function makeArchive(name: string, count = 1): string {
  const source = path.join(root, `archive-${name}`);
  const dir = path.join(source, "versions", version);
  writeFixture(path.join(dir, "records.ndjson"), records);
  writeFixture(path.join(dir, "text-index.json"), text);
  writeFixture(path.join(dir, "meta.json"), metadata(CACHE_VERSION, "2026-10-10T00:00:00.000Z", count));
  writeFixture(path.join(source, "registry-entry.json"), JSON.stringify(entry(CACHE_VERSION, "2026-10-10T00:00:00.000Z")));
  const archive = path.join(root, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "versions", "registry-entry.json"], { stdio: "pipe" });
  return archive;
}

function installed(name: string, metadataVersion: number | undefined, registryVersion = metadataVersion): string {
  const dataDir = path.join(root, name);
  const dir = path.join(dataDir, "versions", version);
  writeFixture(path.join(dir, "records.ndjson"), records);
  writeFixture(path.join(dir, "text-index.json"), text);
  writeFixture(path.join(dir, "meta.json"), metadata(metadataVersion, "previous-install"));
  writeFixture(path.join(dataDir, "registry.json"), JSON.stringify({ cache_version: CACHE_VERSION, versions: {
    [version]: entry(registryVersion, "previous-install"),
    "8.8.8": { version: "8.8.8", cache_version: CACHE_VERSION, records: 7 },
  } }));
  return dataDir;
}

function snapshot(dataDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of ["registry.json", ...["records.ndjson", "text-index.json", "meta.json"].map((name) => path.join("versions", version, name))]) {
    result[file] = fs.readFileSync(path.join(dataDir, file), "utf8");
  }
  return result;
}

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "build", "scripts", "fetch-index.mjs"), ...args], {
      cwd: workingDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, output: output + (signal ? `\nTerminated: ${signal}` : "") }));
  });
}

const requests: string[] = [];
const server = createServer((request, response) => {
  requests.push(request.url ?? "");
  const archive = request.url === "/current" ? currentArchive : request.url === "/wrong-count" ? invalidArchive : null;
  if (!archive) { response.writeHead(503); response.end("fixture download unavailable"); return; }
  response.writeHead(200, { "content-type": "application/gzip", "content-length": fs.statSync(archive).size });
  fs.createReadStream(archive).pipe(response);
});
let currentArchive: string;
let invalidArchive: string;

try {
  currentArchive = makeArchive("current");
  invalidArchive = makeArchive("wrong-count", 2);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const fetchArgs = (dataDir: string, resource = "current") => ["--out", dataDir, "--from", `${url}/${resource}`, version];
  const assertUpdated = (dataDir: string): void => {
    const meta = parseObject(fs.readFileSync(path.join(dataDir, "versions", version, "meta.json"), "utf8"));
    assert.equal(meta.cache_version, CACHE_VERSION);
    assert.equal(meta.built_at, "2026-10-10T00:00:00.000Z");
    const registry = parseObject(fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"));
    assert.ok(typeof registry.versions === "object" && registry.versions !== null);
    assert.equal(parseObject(JSON.stringify(registry.versions))["8.8.8"] !== undefined, true, "Updating one version preserves other registry entries.");
    assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith(".bevy-index-stage-")));
  };

  await test("fetch-index skips a valid current cache without making a request", async () => {
    const dataDir = installed("current-cache", CACHE_VERSION);
    const before = snapshot(dataDir);
    const previousRequests = requests.length;
    const result = await run(fetchArgs(dataDir));
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /already present.*format v5/);
    assert.equal(requests.length, previousRequests);
    assert.deepEqual(snapshot(dataDir), before);
  });

  await test("fetch-index updates a known stale cache even with --no-recheck", async () => {
    const dataDir = installed("stale-cache", CACHE_VERSION - 1, CACHE_VERSION);
    const previousRequests = requests.length;
    const result = await run([...fetchArgs(dataDir), "--no-recheck"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /installed index is format v4/);
    assert.equal(requests.length, previousRequests + 1);
    assertUpdated(dataDir);
  });

  await test("fetch-index falls back to the version entry when metadata has no format", async () => {
    const dataDir = installed("registry-stale-cache", undefined, CACHE_VERSION - 1);
    const result = await run(fetchArgs(dataDir));
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /installed index is format v4/);
    assertUpdated(dataDir);
  });

  await test("fetch-index re-downloads a cache with unknown format by default", async () => {
    const dataDir = installed("unknown-cache", undefined);
    const previousRequests = requests.length;
    const result = await run(fetchArgs(dataDir));
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /does not record a format version/);
    assert.equal(requests.length, previousRequests + 1);
    assertUpdated(dataDir);
  });

  await test("fetch-index --no-recheck keeps an unknown format and reports it accurately", async () => {
    const dataDir = installed("keep-unknown-cache", undefined);
    const before = snapshot(dataDir);
    const previousRequests = requests.length;
    const result = await run(["--no-recheck", ...fetchArgs(dataDir)]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /unknown format.*--no-recheck/);
    assert.doesNotMatch(result.output, /format v5/);
    assert.equal(requests.length, previousRequests);
    assert.deepEqual(snapshot(dataDir), before);
  });

  await test("fetch-index --force overrides --no-recheck for an unknown format", async () => {
    const dataDir = installed("force-unknown-cache", undefined);
    const previousRequests = requests.length;
    const result = await run([...fetchArgs(dataDir), "--force", "--no-recheck"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(requests.length, previousRequests + 1);
    assertUpdated(dataDir);
  });

  await test("failed stale-cache download and validation preserve every installed file", async () => {
    for (const resource of ["unavailable", "wrong-count"]) {
      const dataDir = installed(`failed-update-${resource}`, CACHE_VERSION - 1);
      const before = snapshot(dataDir);
      const result = await run(fetchArgs(dataDir, resource));
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, resource === "unavailable" ? /HTTP 503/ : /API record count mismatch/);
      assert.deepEqual(snapshot(dataDir), before);
      assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith(".bevy-index-stage-")));
    }
  });

  await test("fetch-index documents --no-recheck without requiring a detected version", async () => {
    const previousRequests = requests.length;
    const help = await run(["--help"]);
    assert.equal(help.code, 0, help.output);
    assert.match(help.output, /--no-recheck.*\n.*--force/s);
    assert.match(help.output, /known stale formats still update/);
    assert.equal(requests.length, previousRequests);
    const invalid = await run(["--no-rechecks"]);
    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /Unknown option/);
  });
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
