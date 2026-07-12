import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { listCurrentTemplates, saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { createLibraryDoctorNewTemplateProposal } from "../dist-tateside-api/tateside-api/src/libraryDoctorNewTemplate.js";
import { createLibraryDoctorProposal, listLibraryDoctorProposalHistory, listLibraryDoctorProposals, reviewLibraryDoctorProposal } from "../dist-tateside-api/tateside-api/src/libraryDoctorStore.js";
import { openJetbuiltHistoryDatabase, runJetbuiltHistoryMigrations } from "../dist-tateside-api/tateside-api/src/jetbuiltHistoryStore.js";
import { createMcpLibraryTools } from "../dist-tateside-api/tateside-api/src/mcpLibrary.js";
import { listRegistryAliases, listRegistryValues, seedTaxonomyRegistry } from "../dist-tateside-api/tateside-api/src/taxonomyRegistryStore.js";

function withDb(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-new-template-"));
  const db = openDatabase(path.join(root, "store.db"));
  try {
    runMigrations(db);
    seedTaxonomyRegistry(db);
    return run(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function counts(db) {
  const count = (table) => Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  return {
    templates: listCurrentTemplates(db).length,
    devices: count("devices"),
    deviceVersions: count("device_versions"),
    taxonomyValues: count("taxonomy_registry_values"),
    taxonomyAliases: count("taxonomy_registry_aliases"),
    taxonomyEvents: count("taxonomy_registry_events"),
    schematics: count("schematics"),
    schematicVersions: count("schematic_versions"),
  };
}

function rows(db, table) {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function canonicalFingerprint(db) {
  return JSON.stringify({
    templates: listCurrentTemplates(db),
    devices: rows(db, "devices"),
    deviceVersions: rows(db, "device_versions"),
    schematics: rows(db, "schematics"),
    schematicVersions: rows(db, "schematic_versions"),
    taxonomyValues: rows(db, "taxonomy_registry_values"),
    taxonomyAliases: rows(db, "taxonomy_registry_aliases"),
    taxonomyEvents: rows(db, "taxonomy_registry_events"),
  });
}

function historyFingerprint(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}

function neat(overrides = {}) {
  return {
    proposedTemplate: {
      manufacturer: "Neat",
      modelNumber: "Neat Center",
      label: "Neat Center",
      shortName: "Neat Center",
      category: "Sources",
      deviceType: "camera",
      roleTags: ["conferencing"],
      deviceCapabilities: ["poe-powered"],
      protocols: [],
      heightMm: 297,
      widthMm: 84,
      depthMm: 84,
      weightKg: 1.47,
      ports: [
        { id: "ethernet-poe", label: "PoE / Ethernet", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45", section: "Network / Power" },
        { id: "usb-c-debug", label: "USB-C Debug Only", signalType: "usb", direction: "bidirectional", connectorType: "usb-c", section: "Service" },
      ],
      searchTerms: ["Neat Center", "NEATCENTER-SE", "360 camera"],
      referenceUrl: "https://neat.no/center/",
    },
    identityAliases: ["NEATCENTER-SE", "NEATCENTERSE", "Neat Center SE"],
    evidenceRefs: [{ type: "official-product-page", url: "https://neat.no/center/", title: "Neat Center" }],
    rationale: "Official identity and bounded historical evidence show a missing canonical device.",
    classificationConfidence: "high",
    risk: "medium",
    historicalUsageEvidence: { candidateKey: "neat::neatcenterse", occurrences: 7, quantity: 7, projects: 1, rooms: 7, completedProjects: 1, priorityScore: 62.5 },
    operationalNotes: ["Pairs over the wired subnet.", "USB-C is debug only.", "Do not model future-use Wi-Fi as active."],
    createdBy: "phase4-test",
    ...overrides,
  };
}

test("new-template proposal creation and acceptance remain proposal-only", () => withDb((db) => {
  saveTemplates(db, { templates: [{ label: "Neat Bar", manufacturer: "Neat", modelNumber: "Neat Bar", category: "Codecs", deviceType: "video-codec", ports: [] }] });
  const before = counts(db);
  const registryBefore = JSON.stringify({ values: listRegistryValues(db), aliases: listRegistryAliases(db) });
  const result = createLibraryDoctorNewTemplateProposal(db, neat());
  assert.equal(result.success, true);
  assert.equal(result.proposalOnly, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.applied, false);
  assert.equal(result.proposal.status, "pending");
  assert.equal(result.proposal.proposalType, "new-template");
  assert.equal(result.proposal.proposedValue.proposedTemplate.modelNumber, "Neat Center");
  assert.equal(result.proposal.proposedValue.proposalMetadata.historicalUsageEvidence.rooms, 7);
  assert.equal(result.proposal.evidenceRefs.length, 1);
  assert.equal(result.possibleRelatedTemplates.length, 1);
  assert.match(result.warnings.join("\n"), /Same-manufacturer/);
  assert.deepEqual(counts(db), before);
  const canonicalBefore = canonicalFingerprint(db);
  assert.equal(canonicalFingerprint(db), canonicalBefore);
  assert.equal(JSON.stringify({ values: listRegistryValues(db), aliases: listRegistryAliases(db) }), registryBefore);
  assert.equal(listLibraryDoctorProposals(db).length, 1);

  reviewLibraryDoctorProposal(db, result.proposal.id, { status: "accepted", reviewedBy: "reviewer" });
  assert.deepEqual(counts(db), before);
  assert.equal(canonicalFingerprint(db), canonicalBefore);
  assert.equal(listLibraryDoctorProposalHistory(db, result.proposal.id).at(-1).newStatus, "accepted");

  const idempotent = createLibraryDoctorNewTemplateProposal(db, neat());
  assert.equal(idempotent.alreadyExisting, true);
  assert.equal(idempotent.proposal.id, result.proposal.id);
  assert.equal(idempotent.proposalId, result.proposal.id);
  assert.equal(idempotent.status, "accepted");
  assert.equal(listLibraryDoctorProposals(db).length, 1);
}));

test("rejection and supersession preserve immutable proposal history without canonical writes", () => withDb((db) => {
  const before = counts(db);
  const original = createLibraryDoctorNewTemplateProposal(db, neat({ generationKey: "neat-center-v1" })).proposal;
  reviewLibraryDoctorProposal(db, original.id, { status: "rejected", reviewedBy: "reviewer" });
  assert.deepEqual(counts(db), before);

  const current = createLibraryDoctorNewTemplateProposal(db, neat({ generationKey: "neat-center-v2" })).proposal;
  const replacement = createLibraryDoctorNewTemplateProposal(db, neat({ generationKey: "neat-center-v3", supersedesProposalId: current.id, rationale: "Immutable corrected revision" })).proposal;
  reviewLibraryDoctorProposal(db, current.id, { status: "superseded", reviewedBy: "reviewer" });
  assert.equal(replacement.supersedesProposalId, current.id);
  assert.equal(listLibraryDoctorProposalHistory(db, current.id).length, 2);
  assert.equal(listLibraryDoctorProposalHistory(db, replacement.id).length, 1);
  assert.deepEqual(counts(db), before);
}));

test("deterministic collision and validation results reject malformed proposals", () => withDb((db) => {
  saveTemplates(db, { templates: [{ label: "Existing Camera", manufacturer: "Acme", modelNumber: "CAM-1", category: "Sources", deviceType: "camera", searchTerms: ["shared-term"], ports: [] }] });
  const baseCount = listLibraryDoctorProposals(db).length;
  const duplicate = createLibraryDoctorNewTemplateProposal(db, neat({ proposedTemplate: { ...neat().proposedTemplate, manufacturer: "ACME", modelNumber: "cam 1" } }));
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.exactCanonicalCollisions.length, 1);
  const labelDuplicate = createLibraryDoctorNewTemplateProposal(db, neat({ proposedTemplate: { ...neat().proposedTemplate, manufacturer: "ACME", modelNumber: "Existing Camera" }, generationKey: "label-duplicate" }));
  assert.equal(labelDuplicate.success, false);
  assert.equal(labelDuplicate.exactCanonicalCollisions.length, 1);

  const alias = createLibraryDoctorNewTemplateProposal(db, neat({ identityAliases: ["CAM-1"], generationKey: "alias-warning" }));
  assert.equal(alias.success, true);
  assert.equal(alias.exactAliasCollisions.length, 1);

  for (const [mutate, pattern] of [
    [(value) => { delete value.manufacturer; }, /manufacturer/],
    [(value) => { delete value.modelNumber; }, /modelNumber/],
    [(value) => { delete value.label; }, /label/],
    [(value) => { value.category = "Unknown Category"; }, /Unknown category/],
    [(value) => { value.deviceType = "unknown-device"; }, /Unknown deviceType/],
    [(value) => { value.roleTags = ["unknown-role"]; }, /Unknown roleTag/],
    [(value) => { value.deviceCapabilities = ["unknown-capability"]; }, /Unknown deviceCapability/],
    [(value) => { value.protocols = ["unknown-protocol"]; }, /Unknown protocol/],
    [(value) => { value.ports[0].connectorType = "bad-connector"; }, /connectorType/],
    [(value) => { value.ports[0].signalType = "bad-signal"; }, /signalType/],
    [(value) => { value.ports[0].direction = "sideways"; }, /direction/],
    [(value) => { value.ports[1].id = value.ports[0].id; }, /Duplicate port id/],
  ]) {
    const input = structuredClone(neat());
    mutate(input.proposedTemplate);
    input.generationKey = `invalid-${pattern}`;
    const result = createLibraryDoctorNewTemplateProposal(db, input);
    assert.equal(result.success, false);
    assert.match(result.validationIssues.join("\n"), pattern);
  }
  assert.equal(listLibraryDoctorProposals(db).length, baseCount + 1);
}));

test("MCP adapter exposes one proposal-only new-template tool and no apply path", () => withDb((db) => {
  const historyRoot = mkdtempSync(path.join(os.tmpdir(), "tateside-history-"));
  const historyDb = openJetbuiltHistoryDatabase(path.join(historyRoot, "history.db"));
  try {
    runJetbuiltHistoryMigrations(historyDb);
    const historyBefore = historyFingerprint(historyDb);
    const tools = createMcpLibraryTools({ db, historyDb, config: { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true } });
    const before = counts(db);
    const canonicalBefore = canonicalFingerprint(db);
    assert.throws(() => createLibraryDoctorProposal(db, { templateId: "new-template:direct", field: "template", proposalType: "new-template" }), /validated new-template workflow/);
    const result = tools.execute("create_library_doctor_new_template_proposal", neat({ generationKey: "mcp-neat-center" }));
    assert.equal(result.proposal.status, "pending");
    assert.equal(result.proposalOnly, true);
    assert.equal(result.applied, false);
    assert.deepEqual(counts(db), before);
    assert.equal(canonicalFingerprint(db), canonicalBefore);
    assert.equal(historyFingerprint(historyDb), historyBefore);
    assert.throws(() => tools.execute("apply_library_doctor_new_template_proposal", {}), /Unknown MCP tool/);
  } finally {
    historyDb.close();
    rmSync(historyRoot, { recursive: true, force: true });
  }
}));
