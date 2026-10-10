import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ingestRustdoc, _internal } from "../src/ingest/rustdoc.js";
import { subCrateOf } from "../src/store.js";
import { buildRustdocFixture, tempDir } from "./helpers.mjs";

const owned = !process.env.RESOURCE_FIXTURE_DIR;
const root = process.env.RESOURCE_FIXTURE_DIR ?? tempDir("bevy-rustdoc-metadata-");
try {
  const docDir = owned ? buildRustdocFixture(root) : path.join(root, "rdfixture", "target", "doc");
  const records = ingestRustdoc(docDir, "9.9.9");

  await test("Cargo rustdoc fields inherit the defining type's source link", () => {
    const parent = records.find((record) => record.kind === "struct" && record.name === "Widget");
    assert.ok(parent?.source_ref, "Real rustdoc must provide a source link for Widget.");
    const fields = records.filter((record) => record.kind === "field" && record.owner === "Widget");
    assert.equal(fields.length, 2);
    for (const field of fields) assert.equal(field.source_ref, parent.source_ref);
  });

  await test("Cargo inline doctests keep their item ownership and have no scraped-source claim", () => {
    const type = records.find((record) => record.kind === "struct" && record.name === "Widget");
    const method = records.find((record) => record.kind === "method" && record.owner === "Widget" && record.name === "new");
    assert.ok(type?.examples?.length);
    assert.ok(method?.examples?.length);
    assert.ok(type.examples.some((example) => example.code.includes("Widget::new(7)")));
    assert.ok(method.examples.some((example) => example.code.includes("Widget::new(1)")));
    for (const example of [...type.examples, ...method.examples]) {
      assert.equal(example.scraped, false);
      assert.equal(example.source_file, null);
    }
  });

  await test("facade fields retain docs.rs defining-crate attribution", () => {
    const source = "https://docs.rs/bevy_transform/0.20.0/src/bevy_transform/components/transform.rs.html#78-111";
    const html = `<h1>Struct Transform</h1><a class="src rightside" href="${source}">Source</a>
      <pre class="item-decl"><code>pub struct Transform { /* fields */ }</code></pre>
      <span class="structfield" id="structfield.translation"><code>translation: Vec3</code></span>
      <div class="docblock">The position of the entity.</div>`;
    const parsed = _internal.parsePage(html, path.join(docDir, "bevy", "prelude", "struct.Transform.html"), docDir, "0.20.0");
    const field = parsed.find((record) => record.kind === "field" && record.name === "translation");
    assert.ok(field);
    assert.equal(field.owner, "Transform");
    assert.equal(field.source_ref, source);
    assert.equal(subCrateOf(field), "bevy_transform");
    assert.equal(field.bevy_version, "0.20.0");
  });

  await test("scraped snippets retain their source filename, while inline compile-fail snippets remain inline", () => {
    const html = `<h1>Struct ScrapedWidget</h1><pre class="item-decl"><code>pub struct ScrapedWidget;</code></pre>
      <details class="top-doc"><div class="docblock"><pre class="rust-example-rendered"><code>let inline = true;</code></pre></div></details>
      <section id="impl-ScrapedWidget" class="impl"><h3 class="code-header">impl ScrapedWidget</h3></section>
      <details class="method-toggle"><summary><section id="method.show"><h4 class="code-header">pub fn show()</h4></section></summary>
      <div class="docblock"><div class="scraped-example"><div class="scraped-example-title"><a>examples/render.rs</a></div>
        <div class="example-wrap"><pre class="rust"><code><span data-nosnippet>42</span>render_widget();</code></pre></div></div>
        <pre class="compile_fail"><code>does_not_compile();</code></pre></div></details>`;
    const parsed = _internal.parsePage(html, path.join(docDir, "rdfixture", "struct.ScrapedWidget.html"), docDir, "9.9.9");
    const parent = parsed.find((record) => record.kind === "struct");
    const method = parsed.find((record) => record.kind === "method" && record.name === "show");
    assert.deepEqual(parent?.examples?.map((example) => [example.code, example.scraped, example.source_file]), [["let inline = true;", false, null]]);
    assert.equal(method?.examples?.length, 2);
    const scraped = method.examples.find((example) => example.scraped);
    assert.ok(scraped);
    assert.equal(scraped.code, "render_widget();");
    assert.equal(scraped.source_file, "examples/render.rs");
    const inline = method.examples.find((example) => example.compile_fail);
    assert.ok(inline);
    assert.equal(inline.scraped, false);
    assert.equal(inline.source_file, null);
  });

  await test("scraped snippets with missing or blank titles use null source filenames", () => {
    for (const title of ["", '<div class="scraped-example-title">   </div>']) {
      const html = `<h1>Struct ScrapedWidget</h1><pre class="item-decl"><code>pub struct ScrapedWidget;</code></pre>
        <details class="top-doc"><div class="docblock"><div class="scraped-example">${title}
          <div class="example-wrap"><pre class="rust ignore"><code>unknown_source();</code></pre></div></div></div></details>`;
      const parsed = _internal.parsePage(html, path.join(docDir, "rdfixture", "struct.ScrapedWidget.html"), docDir, "9.9.9");
      const example = parsed.find((record) => record.kind === "struct")?.examples?.[0];
      assert.ok(example);
      assert.equal(example.scraped, true);
      assert.equal(example.ignored, true);
      assert.equal(example.source_file, null);
    }
  });
} finally {
  if (owned) fs.rmSync(root, { recursive: true, force: true });
}
