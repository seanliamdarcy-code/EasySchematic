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

function withTools(run, flags = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-library-"));
  const db = openDatabase(path.join(root, "store.db"));
  try {
    runMigrations(db);
    seedTaxonomyRegistry(db);
    const templates = saveTemplates(db, { templates: [{
      label: "Bad DSP", manufacturer: "Acme", modelNumber: "DSP-1", deviceType: "audio-dsp", category: "Video", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
    }, {
      label: "Incomplete DSP", manufacturer: "Acme", modelNumber: "DSP-2", deviceType: "audio-dsp", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
    }, {
      label: "Third DSP", manufacturer: "Acme", modelNumber: "DSP-3", deviceType: "audio-dsp", category: "Audio", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
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
  assert.equal(tools.execute("get_library_coverage").totalTemplates, 3);
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
