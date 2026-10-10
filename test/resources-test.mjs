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
    // StdioClientTransport merges only a small default allowlist, so the
    // caller's env must be spread through or the fixture's data dir is dropped
    // and the server falls back to an empty index.
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

  console.log("\nresources/read - index");
  const idx = await client.readResource({ uri: "bevy://index/versions" });
  const idxText = idx.contents[0].text;
  check("index lists an active version", /Active.*\*\*/.test(idxText));
  check("index shows a URI example", idxText.includes("bevy://api/"));

  console.log("\nresources/read - a single item");
  // Accepts any semver-shaped version, not just 0.x: the CI fixture index is
  // built from a synthetic crate at 9.9.9.
  const v = /\*\*(\d+\.\d+\.\d+[^\s*]*)\*\*/.exec(idxText)?.[1];
  check("extracted a version from the index", !!v, `version=${v}`);

  // The item to read is whatever the index actually holds. Hardcoding a Bevy
  // path made this fail against the CI fixture, and silently pass nothing when
  // the index was empty.
  const probe = await client.readResource({
    uri: `bevy://kind/${encodeURIComponent(v || "0.0.0")}/struct`,
  });
  const probeText = probe.contents[0].text;
  // The listing renders each item as a bullet plus a `bevy://api/...` URI on the
  // next line; the path is percent-encoded inside that URI, so decode it rather
  // than trying to match the display form.
  const apiUriMatch = /bevy:\/\/api\/[^/\s]+\/([^\s`)]+)/.exec(probeText);
  const itemPath = apiUriMatch ? decodeURIComponent(apiUriMatch[1]) : null;
  check("found a struct to read by exact path", !!itemPath, itemPath || probeText.slice(0, 160));

  if (v && itemPath) {
    const u = `bevy://api/${encodeURIComponent(v)}/${encodeURIComponent(itemPath)}`;
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

    console.log("\nresources/read - fields");
    // Field records are the point of the ingest work, and they are deliberately
    // absent from the search index, so the resource layer is the only way to
    // reach them. This is the assertion that would have caught them going missing.
    try {
      const fields = await client.readResource({
        uri: `bevy://kind/${encodeURIComponent(v)}/field`,
      });
      check(
        "field records are readable through the resource layer",
        fields.contents[0].text.includes("field"),
        fields.contents[0].text.slice(0, 120),
      );
    } catch (err) {
      check("field records are readable through the resource layer", false, String(err.message).slice(0, 100));
    }
  }

  console.log("\nresources/read - error semantics");
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
  // `fn` is the kind the fixture deliberately makes large (>50 items) so that
  // the cursor path is actually exercised rather than skipped.
  const listUri = `bevy://kind/${encodeURIComponent(v || "0.0.0")}/fn`;
  const p1 = await client.readResource({ uri: listUri });
  check("kind listing returns a page", p1.contents[0].text.includes("item(s)"));
  const hasNext = /cursor=/.test(p1.contents[0].uri);
  check("exposes a next cursor when more remain", hasNext, p1.contents[0].uri);
  if (hasNext) {
    const p2 = await client.readResource({ uri: p1.contents[0].uri });
    check("cursor continues the listing", p2.contents[0].text !== p1.contents[0].text);
    check(
      "second page reports items remain",
      p2.contents[0].text.includes("item(s)"),
      p2.contents[0].text.slice(0, 100),
    );
  } else {
    // A single-page fixture means the cursor protocol was NOT exercised. Say so
    // loudly rather than counting it as a pass -- a green run must not be able to
    // hide an untested path.
    console.log(
      "  SKIP cursor continuation: fixture fits in one page, so this path is " +
        "unverified by this run (see test/run-tests.mjs pagination unit tests)",
    );
  }

  console.log("\ncompletion/complete");
  try {
    const comp = await client.complete({
      ref: { type: "ref/resource", uri: "bevy://api/{version}/{path}" },
      argument: { name: "version", value: (v || "0.0.0").split(".").slice(0, 2).join(".") },
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
