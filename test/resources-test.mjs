/**
 * Resource-layer tests against a real MCP client.
 *
 * This is the spec-conformance harness the tool tests are not: it checks the
 * primitive the SDK will not error on for you (resources/list, templates,
 * completion, cursors, error codes).
 *
 * Run: node test/resources-test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? ` -- ${extra}` : ""}`);
  }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--max-old-space-size=2048", "./index.js"],
  env: {
    ...process.env,
    BEVY_MCP_OFFLINE: "1",
  },
  stderr: "inherit",
});

const client = new Client({ name: "resources-test", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("\ncapabilities");
  const caps = client.getServerCapabilities() || {};
  check("declares resources capability", "resources" in caps, JSON.stringify(caps));
  check("declares completions capability", "completions" in caps);

  console.log("\nresources/list");
  const list = await client.listResources();
  check("returns at least the index resource", list.resources.length >= 1);
  check(
    "index resource has a bevy:// uri",
    list.resources.some((r) => r.uri.startsWith("bevy://")),
    JSON.stringify(list.resources.map((r) => r.uri)),
  );

  console.log("\nresources/templates/list");
  const tpl = await client.listResourceTemplates();
  const uris = tpl.resourceTemplates.map((t) => t.uriTemplate);
  check("exposes an api template", uris.some((u) => u.includes("/api/")), uris.join(", "));
  check("exposes a crate template", uris.some((u) => u.includes("/crate/")), uris.join(", "));
  check("exposes an owner template", uris.some((u) => u.includes("/owner/")), uris.join(", "));
  check(
    "every template has a name, title and description",
    tpl.resourceTemplates.every((t) => t.name && t.title && t.description),
  );

  console.log("\nresources/read — index");
  const idx = await client.readResource({ uri: "bevy://index/versions" });
  const idxText = idx.contents[0].text;
  check("index lists an active version", /Active.*\*\*/.test(idxText));
  check("index shows a URI example", idxText.includes("bevy://api/"));

  console.log("\nresources/read — a single item");
  const v = /\*\*(0\.\d+\.\d+[^\s*]*)\*\*/.exec(idxText)?.[1];
  check("extracted a version from the index", !!v, `version=${v}`);
  if (v) {
    const u = `bevy://api/${encodeURIComponent(v)}/${encodeURIComponent(
      "bevy::camera::primitives::Sphere",
    )}`;
    let got;
    try {
      got = await client.readResource({ uri: u });
      const t = got.contents[0].text;
      check("reads a struct by exact path", /\bstruct\b/.test(t), t.slice(0, 120));
      check("reports the version it came from", t.includes(v));
      check("marks the source as read (not searched)", t.includes("Read from"));
    } catch (err) {
      check("reads a struct by exact path", false, String(err.message).slice(0, 120));
    }
  }

  console.log("\nresources/read — error semantics");
  try {
    await client.readResource({
      uri: `bevy://api/${encodeURIComponent(v || "0.19.1")}/${encodeURIComponent("no::such::Item")}`,
    });
    check("unknown path yields -32602", false, "expected an error");
  } catch (err) {
    check(
      "unknown path yields -32602",
      err.code === -32602 || /not found|no api item/i.test(err.message),
      `code=${err.code} msg=${String(err.message).slice(0, 90)}`,
    );
  }
  try {
    // Use a syntactically valid URL with a foreign scheme. A bare string like
    // "not-a-bevy-uri" is rejected by the SDK's own `new URL()` before the
    // server handler runs, so it cannot exercise our scheme guard.
    await client.readResource({ uri: "https://example.com/not-bevy" });
    check("foreign URI is rejected", false, "expected an error");
  } catch (err) {
    check("foreign URI is rejected", err.code === -32602, `code=${err.code}`);
  }

  console.log("\npagination");
  const crate = `bevy://crate/${encodeURIComponent(v || "0.19.1")}/bevy_app`;
  const p1 = await client.readResource({ uri: crate });
  check("crate listing returns a page", p1.contents[0].text.includes("item(s)"));
  const hasNext = /cursor=/.test(p1.contents[0].uri);
  check("exposes a next cursor when more remain", hasNext, p1.contents[0].uri);
  if (hasNext) {
    const p2 = await client.readResource({ uri: p1.contents[0].uri });
    check("cursor continues the listing", p2.contents[0].text !== p1.contents[0].text);
  }

  console.log("\ncompletion/complete");
  try {
    const comp = await client.complete({
      ref: { type: "ref/resource", uri: "bevy://api/{version}/{path}" },
      argument: { name: "version", value: "0.19" },
    });
    const c = comp.completion || comp;
    check("completes versions", Array.isArray(c.values) && c.values.length > 0, JSON.stringify(c).slice(0, 120));
    check("returns at most 100 values", (c.values || []).length <= 100);
    check("reports hasMore", typeof c.hasMore === "boolean");
  } catch (err) {
    check("completes versions", false, String(err.message).slice(0, 120));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
  console.error("\nFATAL:", err);
  fail++;
} finally {
  await client.close().catch(() => {});
}

process.exit(fail ? 1 : 0);