import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT, fixtureEnv, protocolFixture, errorCode } from "./helpers.mjs";
import { isObject } from "../src/types.js";

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok(Array.isArray(result.content));
  return result.content.filter((block): block is { type: "text"; text: string } =>
    typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string",
  ).map((block) => block.text).join("\n");
}

const { root, dataDir, owned } = await protocolFixture();

try {
  for (const entry of ["build/index.js", "index.js", "bin/bevy-mcp.js"]) {
    await test(`stdio handshake and API lookup through ${entry} from another working directory`, { timeout: 30_000 }, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO_ROOT, entry)],
        cwd: root,
        env: fixtureEnv(root, dataDir),
        stderr: "pipe",
      });
      const client = new Client({ name: "typescript-protocol-tests", version: "1.0.0" });
      try {
        await client.connect(transport, { timeout: 15_000 });
        assert.equal(client.getServerVersion()?.name, "bevy-mcp");
        const result = await client.callTool({ name: "bevy_api", arguments: { symbol: "Widget::new" } });
        assert.notEqual(result.isError, true);
        assert.match(responseText(result), /Creates a widget/);
        assert.match(responseText(result), /pub fn new/);
        const resource = await client.readResource({ uri: "bevy://api/9.9.9/rdfixture%3A%3AWidget" });
        assert.ok(resource.contents.some((content) => "text" in content && content.text.includes("A widget resource")));
        if (entry !== "build/index.js") return;

        const tools = await client.listTools();
        const required = ["bevy_search", "bevy_api", "bevy_migration", "bevy_examples", "bevy_index_status", "bevy_check_version", "bevy_indexed_versions", "bevy_api_diff"];
        for (const name of required) assert.ok(tools.tools.some((tool) => tool.name === name), `Missing ${name}`);

        const search = await client.callTool({ name: "bevy_search", arguments: { query: "Widget::id", limit: 3 } });
        assert.notEqual(search.isError, true);
        assert.match(responseText(search), /Reads the id/);
        const status = await client.callTool({ name: "bevy_index_status", arguments: {} });
        assert.match(responseText(status), /9\.9\.9/);
        const versions = await client.callTool({ name: "bevy_indexed_versions", arguments: {} });
        assert.match(responseText(versions), /9\.9\.9/);
        const check = await client.callTool({ name: "bevy_check_version", arguments: {} });
        assert.match(responseText(check), /offline/i);
        const migration = await client.callTool({ name: "bevy_migration", arguments: { from_version: "9.8", to_version: "9.9" } });
        assert.ok(responseText(migration).length > 0);
        const examples = await client.callTool({ name: "bevy_examples", arguments: { task: "widget", limit: 2 } });
        assert.ok(responseText(examples).length > 0);
        const diff = await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "Widget::new" } });
        assert.ok(responseText(diff).length > 0);

        const unknown = await client.callTool({ name: "bevy_api", arguments: { symbol: "Widget::new", version: "1.2.3" } });
        assert.ok(unknown.isError === true || /not indexed|unavailable|unknown/i.test(responseText(unknown)));
        assert.ok(!responseText(unknown).includes("Creates a widget"), "Unknown version must not return active API facts");
        await assert.rejects(client.readResource({ uri: "bevy://api/1.2.3/rdfixture%3A%3AWidget" }), (error: unknown) => errorCode(error) === -32602);
        const invalid = await client.callTool({ name: "bevy_search", arguments: { query: "widget", limit: -1 } });
        assert.equal(invalid.isError, true);
      } finally {
        await client.close();
      }
    });
  }
  await test("MCP historical reads and API diffs use each version's own index", { timeout: 30_000 }, async () => {
    const historical = path.join(root, "historical-docs");
    fs.cpSync(path.join(root, "rdfixture", "target", "doc"), historical, { recursive: true });
    const page = path.join(historical, "rdfixture", "struct.Widget.html");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8").replaceAll("u32", "u64"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "build", "index.js")],
      cwd: root,
      env: { ...fixtureEnv(root, dataDir), BEVY_EXTRA_VERSIONS: `9.9.8=${historical}` },
      stderr: "pipe",
    });
    const client = new Client({ name: "multiversion-tests", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 15_000 });
      const current = await client.callTool({ name: "bevy_api", arguments: { symbol: "Widget::id", version: "9.9.9" } });
      const previous = await client.callTool({ name: "bevy_api", arguments: { symbol: "Widget::id", version: "9.9.8" } });
      assert.notEqual(current.isError, true);
      assert.notEqual(previous.isError, true);
      assert.match(responseText(current), /u32/);
      assert.doesNotMatch(responseText(current), /u64/);
      assert.match(responseText(previous), /u64/);
      assert.doesNotMatch(responseText(previous), /u32/);
      const diff = await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "Widget::id", versions: "9.9.8,9.9.9" } });
      assert.notEqual(diff.isError, true);
      assert.match(responseText(diff), /u32/);
      assert.match(responseText(diff), /u64/);
      for (const versions of ["9.9.9", "9.9.9,9.9.9", " , "]) {
        const single = await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "Widget::id", versions } });
        assert.equal(single.isError, true);
        assert.ok(isObject(single.structuredContent));
        assert.equal(single.structuredContent.comparable, false);
        assert.match(responseText(single), /two distinct/);
      }
      const missingDiff = await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "Widget::id", versions: "1.2.3,9.9.9" } });
      assert.equal(missingDiff.isError, true);
      assert.match(responseText(missingDiff), /not indexed/i);
      assert.doesNotMatch(responseText(missingDiff), /Reads the id/);
      const resource = await client.readResource({ uri: "bevy://api/9.9.8/rdfixture%3A%3AWidget%3A%3Aid" });
      assert.ok(resource.contents.some((content) => "text" in content && /u64/.test(content.text)));
    } finally { await client.close(); }
  });
} finally {
  if (owned) fs.rmSync(root, { recursive: true, force: true });
}
