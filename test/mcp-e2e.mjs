/**
 * End-to-end MCP protocol test: spawns the server over stdio, does the
 * initialize handshake, lists tools, and calls each one.
 * Run: node test/mcp-e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./index.js", ...args],
  env: {
    // Pass the caller's environment through. StdioClientTransport merges only a
    // small default allowlist (PATH, HOME, ...) on top of this object, so
    // without the spread a parent-supplied BEVY_VERSION/BEVY_DOC_DIR would be
    // dropped and the server would fall back to "unversioned". Only fill in
    // defaults when nothing is set, so tests exercise real config detection.
    ...process.env,
    ...(process.env.BEVY_PROJECT_ROOT
      ? {}
      : { BEVY_PROJECT_ROOT: process.cwd() }),
    ...(process.env.BEVY_VERSION ? {} : { BEVY_VERSION: "0.19.0" }),
    ...(process.env.BEVY_DOC_DIR ? {} : { BEVY_DOC_DIR: "/tmp/opencode/mirror" }),
    ...(process.env.BEVY_EXTRA_VERSIONS
      ? {}
      : { BEVY_EXTRA_VERSIONS: "0.18.1=/tmp/opencode/v18" }),
  },
  stderr: "inherit",
});

const client = new Client({ name: "test-client", version: "1.0.0" });

function show(label, res) {
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  console.log(`\n=========== ${label} ===========`);
  console.log(`isError: ${res.isError ?? false}`);
  console.log(text.slice(0, 1200));
  if (res.structuredContent) {
    console.log("--- structured keys:", Object.keys(res.structuredContent).join(", "));
  }
}

try {
  await client.connect(transport);
  console.log("✅ handshake complete");

  const tools = await client.listTools();
  console.log(`\n✅ tools (${tools.tools.length}):`);
  for (const t of tools.tools) {
    console.log(`   - ${t.name}: ${(t.description || "").slice(0, 70)}...`);
  }

  show("bevy_index_status", await client.callTool({ name: "bevy_index_status", arguments: {} }));
  show("bevy_check_version", await client.callTool({ name: "bevy_check_version", arguments: {} }));
  show("bevy_api App::add_systems", await client.callTool({ name: "bevy_api", arguments: { symbol: "App::add_systems" } }));
  show("bevy_search 'system ordering'", await client.callTool({ name: "bevy_search", arguments: { query: "system ordering", limit: 3 } }));
  show("bevy_migration 0.19->0.20", await client.callTool({ name: "bevy_migration", arguments: { from_version: "0.19", to_version: "0.20", topic: "query" } }));
  show("bevy_examples '2d'", await client.callTool({ name: "bevy_examples", arguments: { task: "2d rendering", limit: 2 } }));
  show("bevy_indexed_versions", await client.callTool({ name: "bevy_indexed_versions", arguments: {} }));
  show("bevy_api_diff", await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "App::add_systems" } }));
  show("bevy_api_diff unindexed version (must refuse)", await client.callTool({ name: "bevy_api_diff", arguments: { symbol: "Query", versions: "0.14.0" } }));
  show("bevy_api unknown version (should warn, not lie)", await client.callTool({ name: "bevy_api", arguments: { symbol: "Query", version: "0.14.0" } }));

  console.log("\n✅ all tool calls returned without protocol errors");
} catch (err) {
  console.error("❌ FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}