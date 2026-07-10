import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { saveTemplates, listCurrentTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { startMcpHttpServer } from "../dist-tateside-api/tateside-api/src/mcpHttpServer.js";
import { listLibraryDoctorProposals } from "../dist-tateside-api/tateside-api/src/libraryDoctorStore.js";
import { listRegistryValues, seedTaxonomyRegistry } from "../dist-tateside-api/tateside-api/src/taxonomyRegistryStore.js";

const templates = [{
  label: "Bad DSP", manufacturer: "Acme", modelNumber: "DSP-1", deviceType: "audio-dsp", category: "Video", ports: [{ id: "in", label: "Input", direction: "input", signalType: "analog-audio", connectorType: "xlr" }],
}, {
  label: "Second DSP", manufacturer: "Acme", modelNumber: "DSP-2", deviceType: "audio-dsp", category: "Audio", ports: [],
}, {
  label: "Camera", manufacturer: "Beta", modelNumber: "CAM-1", deviceType: "camera", category: "Cameras", ports: [],
}];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-http-"));
  const dbPath = path.join(root, "store.db");
  const db = openDatabase(dbPath);
  runMigrations(db);
  seedTaxonomyRegistry(db);
  const saved = saveTemplates(db, { templates });
  db.close();
  return { root, dbPath, saved };
}

function config(dbPath, overrides = {}) {
  return { dbPath, mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true, mcpHttpEnabled: true, mcpHttpHost: "127.0.0.1", mcpHttpPort: 0, mcpHttpAllowNonLoopback: false, ...overrides };
}

function value(result) {
  const item = result.content?.find((entry) => entry.type === "text");
  return JSON.parse(item?.text ?? "null");
}

test("Streamable HTTP discovers and invokes real tools without read side effects", async () => {
  const { root, dbPath, saved } = fixture();
  const beforeDb = openDatabase(dbPath);
  const before = {
    templates: JSON.stringify(listCurrentTemplates(beforeDb)),
    taxonomy: JSON.stringify(listRegistryValues(beforeDb)),
    proposals: listLibraryDoctorProposals(beforeDb).length,
    schema: JSON.stringify(beforeDb.prepare("SELECT * FROM schema_migrations ORDER BY id").all()),
  };
  beforeDb.close();
  const handle = await startMcpHttpServer(config(dbPath));
  const client = new Client({ name: "mcp-http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.endpoint));
  try {
    await client.connect(transport);
    const discovered = await client.listTools();
    const names = discovered.tools.map(({ name }) => name);
    for (const name of ["get_library_coverage", "list_manufacturers", "search_templates", "get_suspicious_templates"]) assert.ok(names.includes(name));
    assert.ok(!names.some((name) => name.toLowerCase().includes("apply")));
    assert.equal(discovered.tools.find(({ name }) => name === "search_templates").annotations.readOnlyHint, true);
    assert.notEqual(discovered.tools.find(({ name }) => name === "create_library_doctor_proposal").annotations.readOnlyHint, true);

    assert.equal(value(await client.callTool({ name: "get_library_coverage", arguments: {} })).totalTemplates, 3);
    assert.equal(value(await client.callTool({ name: "list_manufacturers", arguments: { limit: 1 } })).count, 1);
    const first = value(await client.callTool({ name: "search_templates", arguments: { manufacturer: "Acme", limit: 1 } }));
    const second = value(await client.callTool({ name: "search_templates", arguments: { manufacturer: "Acme", limit: 1, offset: 1 } }));
    assert.equal(first.hasMore, true);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.ok(value(await client.callTool({ name: "get_suspicious_templates", arguments: { limit: 10 } })).count > 0);
    assert.equal((await client.callTool({ name: "not_a_tool", arguments: {} })).isError, true);
    const invalid = await client.callTool({ name: "search_templates", arguments: { limit: 101 } });
    assert.equal(invalid.isError, true);

    const malformed = await fetch(handle.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" });
    assert.ok(malformed.status >= 400);

    const afterReads = {
      templates: JSON.stringify(listCurrentTemplates(handle.db)),
      taxonomy: JSON.stringify(listRegistryValues(handle.db)),
      proposals: listLibraryDoctorProposals(handle.db).length,
      schema: JSON.stringify(handle.db.prepare("SELECT * FROM schema_migrations ORDER BY id").all()),
    };
    assert.deepEqual(afterReads, before);

    const proposal = value(await client.callTool({ name: "create_library_doctor_proposal", arguments: { templateId: saved[0].id, field: "category", currentValue: "Video", proposedValue: "Audio", proposalType: "taxonomy-classification" } }));
    assert.equal(proposal.proposal.status, "pending");
    assert.equal(listLibraryDoctorProposals(handle.db).length, before.proposals + 1);
    assert.equal(JSON.stringify(listCurrentTemplates(handle.db)), before.templates);
    assert.equal(JSON.stringify(listRegistryValues(handle.db)), before.taxonomy);
  } finally {
    await transport.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP startup fails closed for unsafe binds and unsafe databases", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-http-startup-"));
  try {
    const missing = path.join(root, "missing.db");
    await assert.rejects(startMcpHttpServer(config(missing)), /does not exist/);
    assert.equal(existsSync(missing), false);
    const unmigrated = path.join(root, "unmigrated.db");
    new (await import("node:sqlite")).DatabaseSync(unmigrated).close();
    await assert.rejects(startMcpHttpServer(config(unmigrated)), /not migrated/);
    await assert.rejects(startMcpHttpServer(config(unmigrated, { mcpHttpHost: "0.0.0.0" })), /NON_LOOPBACK|non-loopback/i);
    await assert.rejects(startMcpHttpServer(config(unmigrated, { mcpHttpEnabled: false })), /HTTP_ENABLED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdio MCP still starts and discovers the shared registry", async () => {
  const { root, dbPath } = fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-tateside-api/tateside-api/src/mcpServer.js")],
    cwd: process.cwd(),
    env: { ...process.env, TATESIDE_DB_PATH: dbPath, TATESIDE_MCP_LIBRARY_ENABLED: "1", TATESIDE_DYNAMIC_TAXONOMY_ENABLED: "1", TATESIDE_LIBRARY_AUDIT_ENABLED: "1", TATESIDE_LIBRARY_DOCTOR_ENABLED: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(({ name }) => name === "get_library_coverage"));
  } finally {
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});
