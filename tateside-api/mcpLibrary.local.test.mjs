import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { saveTemplates, listCurrentTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { createMcpLibraryTools } from "../dist-tateside-api/tateside-api/src/mcpLibrary.js";
import { createTateSideMcpServer, openMcpDatabase } from "../dist-tateside-api/tateside-api/src/mcpServer.js";
import { listRegistryValues, seedTaxonomyRegistry } from "../dist-tateside-api/tateside-api/src/taxonomyRegistryStore.js";
import { reviewLibraryDoctorProposal } from "../dist-tateside-api/tateside-api/src/libraryDoctorStore.js";

function withTools(run, flags = {}, customTemplates = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-library-"));
  const db = openDatabase(path.join(root, "store.db"));
  try {
    runMigrations(db);
    seedTaxonomyRegistry(db);
    const templates = saveTemplates(db, { templates: customTemplates ?? [{
      label: "Bad DSP", manufacturer: "Acme", modelNumber: "DSP-1", deviceType: "audio-dsp", category: "Video", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
    }, {
      label: "Incomplete DSP", manufacturer: "Acme", modelNumber: "DSP-2", deviceType: "audio-dsp", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
    }, {
      label: "Third DSP", manufacturer: "Acme", modelNumber: "DSP-3", deviceType: "audio-dsp", category: "Audio", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
    }, {
      label: "Beta Camera", manufacturer: "Beta", modelNumber: "CAM-1", deviceType: "camera", category: "Cameras", ports: [{ id: "out", label: "Output", direction: "output", signalType: "hdmi", connectorType: "hdmi" }],
    }] });
    const [template, issueTemplate] = templates;
    const config = { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true, ...flags };
    return run({ db, template, issueTemplate, tools: createMcpLibraryTools({ db, config }), config });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("MCP server initializes and reads support complete bounded traversal", () => withTools(({ db, template, issueTemplate, tools, config }) => {
  const server = createTateSideMcpServer({ db, config });
  assert.equal(server.isConnected(), false);
  const values = tools.execute("list_taxonomy_values", { kind: "category", limit: 1 });
  assert.equal(values.readOnly, true);
  assert.equal(values.limit, 1);
  assert.ok(values.total > values.count);
  const laterValues = tools.execute("list_taxonomy_values", { kind: "category", limit: 1, offset: 1 });
  assert.equal(laterValues.offset, 1);
  assert.notEqual(laterValues.items[0].id, values.items[0].id);
  assert.equal(laterValues.hasMore, laterValues.total > 2);
  const aliases = tools.execute("list_taxonomy_aliases", { limit: 1 });
  assert.equal(aliases.readOnly, true);
  const laterAliases = tools.execute("list_taxonomy_aliases", { limit: 1, offset: 1 });
  assert.notEqual(laterAliases.items[0].id, aliases.items[0].id);
  const found = tools.execute("search_templates", { manufacturer: "Acme", limit: 1 });
  assert.equal(found.count, 1);
  const laterFound = tools.execute("search_templates", { manufacturer: "Acme", limit: 1, offset: 1 });
  assert.notEqual(laterFound.items[0].id, found.items[0].id);
  assert.equal(tools.execute("get_template", { id: template.id }).template.id, template.id);
  const issues = tools.execute("get_template_issues", { id: issueTemplate.id, limit: 1 });
  const laterIssues = tools.execute("get_template_issues", { id: issueTemplate.id, limit: 1, offset: 1 });
  assert.equal(issues.hasMore, true);
  assert.notEqual(laterIssues.items[0].code, issues.items[0].code);
  const audit = tools.execute("get_library_audit", { limit: 1 });
  const laterAudit = tools.execute("get_library_audit", { limit: 1, offset: 1 });
  assert.equal(audit.hasMore, true);
  assert.notDeepEqual(laterAudit.items[0], audit.items[0]);
  assert.equal(tools.execute("preview_template_taxonomy", { id: template.id }).readOnly, true);
  assert.equal(tools.execute("get_library_coverage").totalTemplates, 4);
  assert.throws(() => tools.execute("get_template", { id: "missing" }), /Template not found/);
  assert.throws(() => tools.execute("search_templates", { limit: 101 }), /limit/);
  assert.throws(() => tools.execute("search_templates", { offset: -1 }), /offset/);
}));

test("MCP startup verifies an existing DB without migrating or seeding", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-startup-"));
  const dbPath = path.join(root, "store.db");
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    seedTaxonomyRegistry(db);
    const before = JSON.stringify(listRegistryValues(db));
    db.close();
    const mcpDb = openMcpDatabase(dbPath);
    assert.equal(JSON.stringify(listRegistryValues(mcpDb)), before);
    mcpDb.close();
    const unmigratedPath = path.join(root, "unmigrated.db");
    assert.throws(() => openMcpDatabase(unmigratedPath), /does not exist/);
    assert.equal(existsSync(unmigratedPath), false);
    const unmigratedDb = openDatabase(unmigratedPath);
    unmigratedDb.close();
    assert.throws(() => openMcpDatabase(unmigratedPath), /not migrated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP proposals are queue-only, including accepted registry changes", () => withTools(({ db, template, tools }) => {
  const before = JSON.stringify(listCurrentTemplates(db));
  const proposalResult = tools.execute("create_library_doctor_proposal", {
    templateId: template.id, field: "category", currentValue: "Video", proposedValue: "Audio", proposalType: "taxonomy-classification", confidence: "high", risk: "medium",
  });
  assert.equal(proposalResult.proposal.status, "pending");
  assert.equal(JSON.stringify(listCurrentTemplates(db)), before);
  assert.throws(() => tools.execute("create_library_doctor_proposal", {
    templateId: template.id, field: "category", currentValue: "Audio", proposedValue: "Audio", proposalType: "taxonomy-classification",
  }), /stale/);

  const preview = tools.execute("preview_taxonomy_registry_change", { operation: "create-value", payload: { kind: "category", value: "MCP Test" } });
  assert.equal(preview.readOnly, true);
  const beforeRegistry = JSON.stringify(listRegistryValues(db));
  const registryProposal = tools.execute("create_taxonomy_registry_change_proposal", { operation: "create-value", payload: { kind: "category", value: "MCP Test" }, changeKey: preview.changeKey });
  assert.equal(registryProposal.proposal.proposalType, "taxonomy-registry-change");
  assert.equal(JSON.stringify(listRegistryValues(db)), beforeRegistry);
  reviewLibraryDoctorProposal(db, registryProposal.proposal.id, { status: "accepted" });
  assert.equal(JSON.stringify(listRegistryValues(db)), beforeRegistry);
  assert.equal(JSON.stringify(listCurrentTemplates(db)), before);
  assert.throws(() => tools.execute("create_taxonomy_registry_change_proposal", { operation: "create-value", payload: { kind: "category", value: "Other" }, changeKey: preview.changeKey }), /stale/);
  assert.throws(() => tools.execute("apply_template", {}), /Unknown MCP tool/);
}));

test("MCP feature flags fail closed", () => withTools(({ db, config }) => {
  const tools = createMcpLibraryTools({ db, config: { ...config, mcpLibraryEnabled: false } });
  assert.throws(() => tools.execute("search_templates"), /not enabled/);
  assert.throws(() => createMcpLibraryTools({ db, config: { ...config, dynamicTaxonomyEnabled: false } }).execute("list_taxonomy_values"), /Dynamic taxonomy/);
  assert.throws(() => createMcpLibraryTools({ db, config: { ...config, libraryAuditEnabled: false } }).execute("get_library_audit"), /Library audit/);
  assert.throws(() => createMcpLibraryTools({ db, config: { ...config, libraryDoctorEnabled: false } }).execute("create_library_doctor_proposal", { templateId: "missing" }), /Library Doctor/);
}));

test("MCP intelligence tools are deterministic, bounded, and read-only", () => withTools(({ db, template, tools, config }) => {
  const beforeTemplates = JSON.stringify(listCurrentTemplates(db));
  const beforeRegistry = JSON.stringify(listRegistryValues(db));
  const manufacturers = tools.execute("list_manufacturers", { limit: 1, sort: "name" });
  const laterManufacturers = tools.execute("list_manufacturers", { limit: 1, offset: 1, sort: "name" });
  assert.equal(manufacturers.total, 2);
  assert.equal(manufacturers.items[0].manufacturer, "Acme");
  assert.equal(laterManufacturers.items[0].manufacturer, "Beta");
  assert.equal(manufacturers.hasMore, true);
  assert.equal(tools.execute("get_manufacturer_summary", { manufacturer: "Acme" }).totalTemplates, 3);
  assert.throws(() => tools.execute("get_manufacturer_summary", { manufacturer: "Missing" }), /not found/);
  const related = tools.execute("find_related_templates", { templateId: template.id, limit: 1 });
  assert.ok(related.total >= 2);
  assert.ok(related.items[0].relationshipReasons.includes("same manufacturer"));
  assert.throws(() => tools.execute("find_related_templates", { templateId: template.id, strategy: "semantic" }), /strategy/);
  const conflicts = tools.execute("get_classification_conflicts", { limit: 100 });
  assert.ok(conflicts.items.some((item) => item.conflictType === "deviceType-parent-category-disagreement"));
  const clusters = tools.execute("get_library_issue_clusters", { grouping: "issueCode", limit: 100 });
  assert.ok(clusters.items.some((item) => item.clusterKey === "MISSING_DIMENSIONS"));
  assert.throws(() => tools.execute("get_library_issue_clusters", { grouping: "anything" }), /grouping/);
  const gaps = tools.execute("get_taxonomy_coverage_gaps", { kind: "deviceType", limit: 100 });
  assert.ok(gaps.items.some((item) => item.storedValue === "audio-dsp"));
  const suspicious = tools.execute("get_suspicious_templates", { limit: 100 });
  assert.equal(suspicious.items[0].templateId, template.id);
  assert.ok(suspicious.items[0].score > 0);
  const triage = tools.execute("get_template_triage_bundle", { templateId: template.id });
  assert.equal(triage.template.templateId, template.id);
  assert.ok(Array.isArray(triage.relatedTemplates));
  assert.equal(JSON.stringify(listCurrentTemplates(db)), beforeTemplates);
  assert.equal(JSON.stringify(listRegistryValues(db)), beforeRegistry);
  assert.throws(() => tools.execute("list_manufacturers", []), /object/);
  assert.throws(() => createMcpLibraryTools({ db, config: { ...config, dynamicTaxonomyEnabled: false } }).execute("get_suspicious_templates"), /Dynamic taxonomy/);
}));

test("suspicious scores cap repeated port patterns but preserve distinct errors", () => withTools(({ tools }) => {
  const rows = tools.execute("get_suspicious_templates", { limit: 100 }).items;
  const repeated = rows.find((row) => row.model === "PORT-32");
  const smaller = rows.find((row) => row.model === "PORT-8");
  const distinct = rows.find((row) => row.model === "PORT-DISTINCT");
  assert.equal(repeated.score, smaller.score);
  assert.equal(repeated.errorCount, 32);
  assert.equal(repeated.scoreBreakdown[0].rawCount, 32);
  assert.equal(repeated.scoreBreakdown[0].countedCount, 3);
  assert.equal(repeated.scoreBreakdown[0].patternCount, 1);
  assert.equal(repeated.scoreBreakdown[0].score, 30);
  assert.equal(distinct.scoreBreakdown[0].countedCount, 2);
  assert.equal(distinct.scoreBreakdown[0].score, 20);
  for (const row of [repeated, smaller, distinct]) assert.equal(row.score, row.scoreBreakdown.reduce((sum, reason) => sum + reason.score, 0));
  assert.deepEqual(rows, tools.execute("get_suspicious_templates", { limit: 100 }).items);
}, {}, [
  { label: "Port 32", manufacturer: "Ports", modelNumber: "PORT-32", deviceType: "audio-dsp", category: "Audio", ports: Array.from({ length: 32 }, (_, index) => ({ id: `p${index}`, label: `P${index}`, direction: "input", signalType: "analog-audio", connectorType: "not-a-connector" })) },
  { label: "Port 8", manufacturer: "Ports", modelNumber: "PORT-8", deviceType: "audio-dsp", category: "Audio", ports: Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, label: `P${index}`, direction: "input", signalType: "analog-audio", connectorType: "not-a-connector" })) },
  { label: "Distinct errors", manufacturer: "Ports", modelNumber: "PORT-DISTINCT", deviceType: "audio-dsp", category: "Audio", ports: [
    { id: "connector", label: "Connector", direction: "input", signalType: "analog-audio", connectorType: "not-a-connector" },
    { id: "signal", label: "Signal", direction: "input", signalType: "not-a-signal", connectorType: "hdmi" },
  ] },
]));
