/** Ecosystem compatibility: caret satisfaction and the vendored snapshot. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  buildCompatMatrix,
  loadVendoredCompat,
  parseCaretRange,
  satisfiesRange,
  satisfiesRequirement,
  vendoredCompatPath,
} from "../src/analysis/compat.js";

test("caret ranges on 0.x stop at the next minor (Bevy's breaking boundary)", () => {
  assert.deepEqual(parseCaretRange("^0.20.0"), { min: "0.20.0", max: "0.21.0" });
  assert.deepEqual(parseCaretRange("^0.15.0"), { min: "0.15.0", max: "0.16.0" });
});

test("caret ranges on 1.x+ span the whole major line", () => {
  assert.deepEqual(parseCaretRange("^1.2.3"), { min: "1.2.3", max: "2.0.0" });
});

test("a caret requirement accepts its own minor and rejects neighbours", () => {
  // The regression this guards: `^0.15.0` must not match Bevy 0.20.
  assert.equal(satisfiesRequirement("^0.20.0", "0.20.0"), true);
  assert.equal(satisfiesRequirement("^0.20.0", "0.20.4"), true);
  assert.equal(satisfiesRequirement("^0.20.0", "0.19.1"), false);
  assert.equal(satisfiesRequirement("^0.20.0", "0.21.0"), false);
  assert.equal(satisfiesRequirement("^0.15.0", "0.20.0"), false);
  assert.equal(satisfiesRequirement("^0.15.0", "0.15.3"), true);
});

test("an exact requirement is inclusive, unlike a caret range", () => {
  assert.equal(satisfiesRequirement("0.20.0", "0.20.0"), true);
  assert.equal(satisfiesRequirement("0.20.0", "0.20.1"), false);
  assert.equal(satisfiesRange("0.20.0", "0.20.0", "0.20.0"), false);
});

test("the vendored snapshot covers every indexed plugin crate", () => {
  assert.ok(fs.existsSync(vendoredCompatPath()), "vendor/ecosystem/compat.json is missing");
  for (const crate of ["bevy_egui", "bevy_rapier3d", "leafwing_input_manager"]) {
    const entries = loadVendoredCompat(crate);
    assert.ok(entries.length > 0, `no compat entries for ${crate}`);
    assert.ok(entries.every((e) => e.plugin === crate && typeof e.requires_bevy === "string"));
  }
});

test("compatible plugin versions are selected for the pinned Bevy", () => {
  const egui = loadVendoredCompat("bevy_egui");
  const for020 = egui.filter((e) => satisfiesRequirement(e.requires_bevy, "0.20.0"));
  assert.ok(for020.some((e) => e.plugin_version === "0.43.1"));
  const for015 = egui.filter((e) => satisfiesRequirement(e.requires_bevy, "0.15.3"));
  assert.ok(for015.length > 0);
  assert.ok(!for015.some((e) => e.plugin_version === "0.43.1"));

  const matrix = buildCompatMatrix(egui);
  assert.ok([...matrix.values()].some((plugins) => plugins.includes("bevy_egui@0.43.1")));
});
