import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { listCurrentTemplates, saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import {
  TaxonomyRegistryError,
  commitTaxonomyRegistryChange,
  getRegistryValue,
  listRegistryAliases,
  listRegistryHistory,
  listRegistryValues,
  previewTaxonomyRegistryChange,
  seedTaxonomyRegistry,
} from "../dist-tateside-api/tateside-api/src/taxonomyRegistryStore.js";

function withDb(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "taxonomy-registry-"));
  const db = openDatabase(path.join(root, "tateside.db"));
  try {
    runMigrations(db);
    return fn(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function commit(db, templates, operation, payload, extra = {}) {
  const preview = previewTaxonomyRegistryChange(db, templates, { operation, payload });
  return commitTaxonomyRegistryChange(db, templates, { operation, payload, changeKey: preview.changeKey, actor: "test@example.com", ...extra });
}

function assertRegistryError(fn, status) {
  assert.throws(fn, (error) => error instanceof TaxonomyRegistryError && error.status === status);
}

function template(deviceType, category) {
  return {
    label: `${deviceType} template`,
    manufacturer: "TateSide",
    modelNumber: `${deviceType}-1`,
    deviceType,
    category,
    ports: [{ id: "p1", label: "In", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
  };
}

test("registry seed is idempotent and preserves DB additions", () => withDb((db) => {
  seedTaxonomyRegistry(db);
  const first = listRegistryValues(db);
  assert.ok(first.some((entry) => entry.kind === "category" && entry.value === "Audio"));
  assert.ok(first.some((entry) => entry.kind === "deviceType" && entry.value === "audio-dsp" && entry.parentValue === "Audio"));
  assert.ok(first.some((entry) => entry.kind === "roleTag" && entry.value === "dsp"));
  assert.ok(first.some((entry) => entry.kind === "deviceCapability" && entry.value === "audio-processing"));
  assert.ok(first.some((entry) => entry.kind === "protocol" && entry.value === "dante"));

  commit(db, [], "create-value", { kind: "category", value: "Video Conferencing" });
  seedTaxonomyRegistry(db);

  assert.equal(listRegistryValues(db).length, first.length + 1);
  assert.equal(getRegistryValue(db, "category", "video conferencing").value, "Video Conferencing");
}));

test("value creation validates parents, duplicate keys, metadata, and history", () => withDb((db) => {
  seedTaxonomyRegistry(db);

  const category = commit(db, [], "create-value", { kind: "category", value: "Accessories", label: "Accessories" }).value;
  assert.equal(category.status, "active");
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], { operation: "create-value", payload: { kind: "category", value: " accessories " } }), 409);
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], { operation: "create-value", payload: { kind: "deviceType", value: "ceiling-mic" } }), 400);

  const deviceType = commit(db, [], "create-value", { kind: "deviceType", value: "ceiling-mic", parentValue: "Audio" }).value;
  assert.equal(deviceType.parentValue, "Audio");
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], { operation: "create-value", payload: { kind: "roleTag", value: "ceiling", parentValue: "Audio" } }), 400);

  const updated = commit(db, [], "update-metadata", { kind: "deviceType", value: "ceiling-mic", label: "Ceiling Mic", description: "Installed microphone" }).value;
  assert.equal(updated.value, "ceiling-mic");
  assert.equal(updated.label, "Ceiling Mic");

  const events = listRegistryHistory(db, "value", updated.id);
  assert.deepEqual(events.map((event) => event.eventType), ["created", "metadata-updated"]);
}));

test("deprecation is safe and never mutates templates", () => withDb((db) => {
  seedTaxonomyRegistry(db);
  saveTemplates(db, { templates: [template("wired-mic", "Microphones")], source: "taxonomy-registry-test" });
  const before = JSON.stringify(listCurrentTemplates(db));

  commit(db, [], "create-value", { kind: "deviceType", value: "ceiling-mic", parentValue: "Audio" });
  const preview = previewTaxonomyRegistryChange(db, listCurrentTemplates(db), {
    operation: "deprecate-value",
    payload: { kind: "deviceType", value: "wired-mic", replacementValue: "ceiling-mic" },
  });
  assert.equal(preview.readOnly, true);
  assert.equal(preview.impact.templatesUsingValue, 1);
  assert.equal(preview.impact.replacementValue, "ceiling-mic");

  const deprecated = commitTaxonomyRegistryChange(db, listCurrentTemplates(db), {
    operation: "deprecate-value",
    payload: { kind: "deviceType", value: "wired-mic", replacementValue: "ceiling-mic" },
    changeKey: preview.changeKey,
  }).value;
  assert.equal(deprecated.status, "deprecated");
  assert.equal(JSON.stringify(listCurrentTemplates(db)), before);

  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "deprecate-value",
    payload: { kind: "category", value: "Audio", replacementValue: "Amplifiers" },
  }), 409);
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "deprecate-value",
    payload: { kind: "deviceType", value: "audio-dsp", replacementValue: "audio-dsp" },
  }), 400);
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "deprecate-value",
    payload: { kind: "deviceType", value: "audio-dsp", replacementValue: "missing" },
  }), 400);
}));

test("aliases validate target, collisions, risk, and avoid template rewrites", () => withDb((db) => {
  seedTaxonomyRegistry(db);
  saveTemplates(db, { templates: [template("camera-head", "Sources")], source: "taxonomy-registry-test" });
  const before = JSON.stringify(listCurrentTemplates(db));

  assert.ok(listRegistryAliases(db).some((entry) => entry.kind === "deviceType" && entry.aliasValue === "camera-head" && entry.canonicalValue === "camera"));
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "create-alias",
    payload: { kind: "deviceType", aliasValue: "camera", canonicalValue: "camera", migrationRisk: "low" },
  }), 400);
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "create-alias",
    payload: { kind: "deviceType", aliasValue: "missing-camera", canonicalValue: "missing", migrationRisk: "low" },
  }), 400);

  const alias = commit(db, [], "create-alias", {
    kind: "deviceType",
    aliasValue: "cam-head",
    canonicalValue: "camera",
    migrationRisk: "medium",
    notes: "Short form.",
  }).alias;
  assert.equal(alias.migrationRisk, "medium");
  assertRegistryError(() => previewTaxonomyRegistryChange(db, [], {
    operation: "create-alias",
    payload: { kind: "deviceType", aliasValue: "cam-head", canonicalValue: "camera", migrationRisk: "medium" },
  }), 409);
  assert.equal(JSON.stringify(listCurrentTemplates(db)), before);
}));

test("preview keys are deterministic, stale commits fail, and failed writes are atomic", () => withDb((db) => {
  seedTaxonomyRegistry(db);
  const payload = { kind: "protocol", value: "usb-c" };
  const a = previewTaxonomyRegistryChange(db, [], { operation: "create-value", payload });
  const b = previewTaxonomyRegistryChange(db, [], { operation: "create-value", payload: { value: "usb-c", kind: "protocol" } });
  assert.equal(a.changeKey, b.changeKey);

  assertRegistryError(() => commitTaxonomyRegistryChange(db, [], { operation: "create-value", payload, changeKey: "stale" }), 409);
  assert.throws(() => getRegistryValue(db, "protocol", "usb-c"));

  const metadata = previewTaxonomyRegistryChange(db, [], {
    operation: "update-metadata",
    payload: { kind: "protocol", value: "dante", label: "Dante" },
  });
  commit(db, [], "update-metadata", { kind: "protocol", value: "dante", label: "Dante Audio" });
  assertRegistryError(() => commitTaxonomyRegistryChange(db, [], {
    operation: "update-metadata",
    payload: { kind: "protocol", value: "dante", label: "Dante" },
    changeKey: metadata.changeKey,
  }), 409);
}));
