import assert from "node:assert/strict";
import { test } from "node:test";
import { BevyIndex, findByPath } from "../src/store.js";
import { fixtureRecord } from "./helpers.mjs";

function symbolIndex(): BevyIndex {
  const index = new BevyIndex();
  index.addRecords([
    fixtureRecord({ source: "rustdoc", kind: "struct", name: "New", full_path: "fixture::New", module: "fixture", crate: "fixture" }),
    fixtureRecord({ source: "rustdoc", kind: "method", name: "new", owner: "OtherWidget", full_path: "fixture::other::OtherWidget::new", module: "fixture::other", crate: "fixture" }),
    fixtureRecord({ source: "rustdoc", kind: "method", name: "new", owner: "Widget<T>", full_path: "fixture::widgets::Widget::new", module: "fixture::widgets", crate: "fixture" }),
    fixtureRecord({ source: "rustdoc", kind: "method", name: "new", owner: "Widget", full_path: "fixture::prelude::Widget::new", module: "fixture::prelude", crate: "fixture" }),
    fixtureRecord({ source: "rustdoc", kind: "struct", name: "Widget", full_path: "fixture::widgets::Widget", module: "fixture::widgets", crate: "fixture" }),
  ]);
  index.buildSymbolTable();
  return index;
}

await test("qualified method lookup never returns a same-named type or another owner's method", () => {
  const index = symbolIndex();
  const hits = index.lookupSymbol("Widget::new");
  assert.equal(hits.length, 2);
  assert.ok(hits.every(({ record }) => record.kind === "method" && record.owner?.startsWith("Widget")));
  assert.equal(index.lookupSymbol("OtherWidget::new").length, 1);
  assert.equal(index.lookupSymbol("OtherWidget::new")[0]!.record.owner, "OtherWidget");
});

await test("full and crate-relative symbol paths resolve only their actual records", () => {
  const index = symbolIndex();
  for (const query of ["fixture::widgets::Widget::new", "widgets::Widget::new"]) {
    assert.deepEqual(index.lookupSymbol(query).map(({ record }) => record.full_path), ["fixture::widgets::Widget::new"]);
  }
  assert.equal(index.lookupSymbol("fixture::prelude::Widget::new")[0]!.record.full_path, "fixture::prelude::Widget::new");
});

await test("qualified aliases tolerate case, empty parentheses, whitespace and nested generics", () => {
  const index = symbolIndex();
  for (const query of [
    "WIDGET::NEW( )", "Widget<Vec<Option<u32>>>::new()", "Widget::<Vec<u32>>::new::<Option<u32>>()",
    " fixture :: widgets :: Widget < Vec<Option<u32>> > :: new ( ) ",
  ]) {
    const hits = index.lookupSymbol(query);
    assert.ok(hits.length > 0, query);
    assert.ok(hits.every(({ record }) => record.kind === "method" && record.owner?.startsWith("Widget")), query);
  }
  assert.equal(index.lookupSymbol("Widget<Vec<Option<u32>>>")[0]!.record.kind, "struct");
});

await test("invalid qualified symbols do not fall back to an unrelated leaf or owner", () => {
  const index = symbolIndex();
  for (const query of ["Missing::new", "Missing::Widget::new", "fixture::wrong::Widget::new", "fixture::widgets::new", "Widget<Vec<u32>>::missing"]) {
    assert.deepEqual(index.lookupSymbol(query), [], query);
  }
});

await test("bare lookup keeps same-named types before methods", () => {
  const hits = symbolIndex().lookupSymbol("new");
  assert.equal(hits[0]!.record.kind, "struct");
  assert.ok(hits.some(({ record }) => record.owner === "OtherWidget"));
  assert.ok(hits.some(({ record }) => record.owner?.startsWith("Widget")));
});

await test("bare and relative API resources prefer a defining trait over its derive and prelude aliases", () => {
  const index = new BevyIndex();
  const record = fixtureRecord({ source: "rustdoc", name: "Message", kind: "trait", full_path: "bevy::ecs::message::Message", module: "bevy::ecs::message", bevy_version: "0.20.0" });
  index.addRecords([
    { ...record, kind: "derive" },
    { ...record, full_path: "bevy::prelude::Message", module: "bevy::prelude" },
    record,
  ]);
  index.buildSymbolTable();
  for (const path of ["Message", "ecs::message::Message", record.full_path]) {
    const resolved = findByPath(index, "0.20.0", path);
    assert.equal(resolved?.kind, "trait", path);
    assert.equal(resolved?.full_path, record.full_path, path);
  }
  assert.equal(findByPath(index, "0.16.1", "Message"), null);
});
