#!/usr/bin/env node
/** Verify packaged artifacts and Git preparation from unrelated directories. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_ROOT } from "../src/config.js";
import { isObject } from "./cli-utils.mjs";

function npmExecutable(): string {
  if (!process.env.npm_execpath) throw new Error("Run package verification with npm run test:package.");
  return process.env.npm_execpath;
}
const npmCli = npmExecutable();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bevy-mcp-package-"));

function npm(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: path.resolve(PACKAGE_ROOT, process.env.npm_config_cache || path.join(".cache", "npm")) },
  });
}

async function verifyInstall(installation: string, label: string): Promise<void> {
  const packageRoot = path.join(installation, "node_modules", "bevy-mcp");
  const cli = path.join(packageRoot, "bin", "bevy-mcp.js");
  const cwd = path.join(temporary, `${label}-game with spaces`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "Cargo.lock"), 'version = 3\n[[package]]\nname = "bevy"\nversion = "9.9.9"\n');
  const env = {
    ...process.env, BEVY_PROJECT_ROOT: cwd, BEVY_VERSION: "9.9.9", BEVY_MCP_OFFLINE: "1",
    BEVY_MCP_DATA_DIR: path.join(cwd, "data"), BEVY_DOC_DIR: path.join(cwd, "no-docs"),
    BEVY_WEBSITE_DIR: path.join(packageRoot, "vendor", "bevy-website"), BEVY_EXTRA_VERSIONS: "",
  };
  const help = execFileSync(process.execPath, [cli, "help"], { cwd, env, encoding: "utf8" });
  assert.match(help, /version-accurate Bevy/);
  assert.ok(fs.existsSync(path.join(packageRoot, "vendor", "bevy-website", "content")));
  assert.ok(!fs.existsSync(path.join(installation, "node_modules", "typescript")), "Runtime installation must omit compiler dependencies.");
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], cwd, env, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "bevy_api"));
    const result = await client.callTool({ name: "bevy_index_status", arguments: {} });
    assert.ok(isObject(result.structuredContent));
    assert.equal(result.structuredContent.bevy_version, "9.9.9");
    assert.equal(result.structuredContent.website_dir, env.BEVY_WEBSITE_DIR);
    assert.ok((await client.listResourceTemplates()).resourceTemplates.length > 0);
  } finally {
    await client.close();
  }
  const status = execFileSync(process.execPath, [cli, "status"], { cwd, env, encoding: "utf8" });
  assert.match(status, /9\.9\.9/);
  if (label === "tarball") await verifyIndexBundle(packageRoot, cwd, env);
  console.log(`Verified ${label} installation: CLI, stdio MCP, vendored prose, and runtime-only dependencies.`);
}

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function verifyIndexBundle(packageRoot: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const bundles = path.join(cwd, "bundles");
  execFileSync(process.execPath, [path.join(packageRoot, "scripts", "publish-index.mjs"), "--out", bundles, "--data", path.join(cwd, "data"), "9.9.9"], { cwd, env, stdio: "pipe" });
  const bundle = path.join(bundles, "bevy-index-9.9.9.tar.gz");
  const server = createServer((request, response) => {
    if (request.url === "/valid") fs.createReadStream(bundle).pipe(response);
    else response.end("invalid archive");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const destination = path.join(cwd, "downloaded-data");
  const source = `http://127.0.0.1:${address.port}`;
  const fetchCommand = [path.join(packageRoot, "bin", "bevy-mcp.js"), "fetch-index", "--out", destination, "--from"];
  const detectionEnv: NodeJS.ProcessEnv = { ...env };
  delete detectionEnv.BEVY_PROJECT_ROOT;
  delete detectionEnv.BEVY_VERSION;
  delete detectionEnv.INIT_CWD;
  const configFile = path.join(cwd, "download-config.json");
  fs.writeFileSync(configFile, JSON.stringify({ offline: true }));
  detectionEnv.BEVY_MCP_CONFIG = configFile;
  try {
    const fetched = await runNode([...fetchCommand, `${source}/valid`], cwd, detectionEnv);
    assert.equal(fetched.code, 0, fetched.output);
    const metadataPath = path.join(destination, "versions", "9.9.9", "meta.json");
    const before = fs.readFileSync(metadataPath, "utf8");
    const failed = await runNode([...fetchCommand, `${source}/corrupt`, "--force"], cwd, detectionEnv);
    assert.equal(failed.code, 1, failed.output);
    assert.equal(fs.readFileSync(metadataPath, "utf8"), before, "Failed replacement must preserve the installed index.");
    assert.ok(!fs.readdirSync(destination).some((entry) => entry.startsWith(".bevy-index-stage-")));
    console.log("Verified index archive round-trip, caller Cargo.lock detection, option ordering, and failed-install rollback.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

try {
  const output: unknown = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary, "--loglevel", "error"], PACKAGE_ROOT));
  const entries: unknown[] = Array.isArray(output) ? output : isObject(output) ? Object.values(output) : [];
  assert.equal(entries.length, 1, "npm pack must describe one package.");
  const packed = entries[0];
  assert.ok(isObject(packed) && typeof packed.filename === "string");
  const files = packed.files;
  assert.ok(Array.isArray(files));
  assert.ok(files.every((file: unknown) => isObject(file) && typeof file.path === "string" && !/\.(?:ts|mts)$/.test(file.path) && !file.path.startsWith("build/test/")));
  const tarball = path.join(temporary, packed.filename);
  const installation = path.join(temporary, "tarball-install");
  fs.mkdirSync(installation);
  fs.writeFileSync(path.join(installation, "package.json"), '{"name":"package-smoke","private":true}\n');
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error", tarball], installation);
  await verifyInstall(installation, "tarball");

  if (process.argv.includes("--git")) {
    const source = path.join(temporary, "git-source");
    fs.cpSync(PACKAGE_ROOT, source, { recursive: true, filter(from) {
      const relative = path.relative(PACKAGE_ROOT, from).replaceAll("\\", "/");
      if (relative !== "" && !/^(?:bin|src|scripts|test|vendor|\.github)(?:\/|$)/.test(relative) && !/^[^/]+\.(?:ts|json|md)$/.test(relative) && !["LICENSE", ".gitignore"].includes(relative)) return false;
      if (relative === "bevy-mcp.config.json") return false;
      return relative !== "index.js" && !/^(?:bin\/.*\.js|(?:scripts|test)\/.*\.mjs)$/.test(relative);
    } });
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Package Smoke", "-c", "user.email=package-smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "package smoke"]]) {
      execFileSync("git", args, { cwd: source, stdio: "pipe" });
    }
    const gitInstallation = path.join(temporary, "git-install");
    fs.mkdirSync(gitInstallation);
    fs.writeFileSync(path.join(gitInstallation, "package.json"), '{"name":"git-smoke","private":true}\n');
    npm(["install", "--allow-git=all", "--omit=dev", "--no-audit", "--no-fund", "--loglevel", "error", `git+${pathToFileURL(source).href}`], gitInstallation);
    await verifyInstall(gitInstallation, "Git prepare");
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
