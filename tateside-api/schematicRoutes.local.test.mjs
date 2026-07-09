import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const accessEmail = "route-test@example.com";

function makeSchematic(name, extra = {}) {
  return {
    version: 1,
    name,
    nodes: [],
    edges: [],
    ...extra,
  };
}

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    "Cf-Access-Authenticated-User-Email": accessEmail,
  };
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a localhost port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl) {
  const healthUrl = new URL("/health", baseUrl);
  const deadline = Date.now() + 10_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`/health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for TateSide API health check");
}

async function startServer(envOverrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-api-routes-"));
  const port = await getAvailablePort();
  const child = spawn(
    process.execPath,
    ["dist-tateside-api/tateside-api/src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TATESIDE_DATA_DIR: root,
        TATESIDE_API_HOST: "127.0.0.1",
        TATESIDE_API_PORT: String(port),
        TATESIDE_REQUIRE_ACCESS_IDENTITY: "1",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Failed to start TateSide API route test server: ${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`,
    );
  }

  return {
    baseUrl: new URL(`http://127.0.0.1:${port}`),
    dataDir: root,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test("schematic routes cover create, save, versions, restore, and validation", async () => {
  const server = await startServer();

  try {
    const listUrl = new URL("/api/tateside/schematics", server.baseUrl);
    const createResponse = await fetch(listUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: makeSchematic("Alpha", {
          metadata: { revision: 1 },
        }),
        source: "route-test-create",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createResponse.status, 201);
    const created = await readJson(createResponse);
    assert.match(created.schematic.id, /^sch_[a-f0-9]{32}$/);
    assert.equal(created.schematic.createdByEmail, accessEmail);
    assert.equal(created.version.source, "route-test-create");
    assert.equal(created.data.name, "Alpha");

    const listResponse = await fetch(listUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(listResponse.status, 200);
    const listed = await readJson(listResponse);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.schematic.id);

    const schematicUrl = new URL(`/api/tateside/schematics/${created.schematic.id}`, server.baseUrl);
    const currentResponse = await fetch(schematicUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(currentResponse.status, 200);
    const current = await readJson(currentResponse);
    assert.equal(current.version.sequence, 1);
    assert.equal(current.data.name, "Alpha");

    const dedupeResponse = await fetch(schematicUrl, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: {
          edges: [],
          metadata: { revision: 1 },
          name: "Alpha",
          nodes: [],
          version: 1,
        },
        source: "route-test-save-noop",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(dedupeResponse.status, 200);
    const deduped = await readJson(dedupeResponse);
    assert.equal(deduped.createdNewVersion, false);
    assert.equal(deduped.schematic.currentVersionSequence, 1);
    assert.equal(deduped.schematic.updatedByEmail, accessEmail);

    const changedResponse = await fetch(schematicUrl, {
      method: "PUT",
      headers: requestHeaders(),
      body: JSON.stringify({
        data: makeSchematic("Alpha v2", {
          metadata: { revision: 2 },
        }),
        source: "route-test-save-changed",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(changedResponse.status, 200);
    const changed = await readJson(changedResponse);
    assert.equal(changed.createdNewVersion, true);
    assert.equal(changed.version.sequence, 2);
    assert.equal(changed.version.source, "route-test-save-changed");
    assert.equal(changed.data.name, "Alpha v2");

    const versionsUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/versions`, server.baseUrl);
    const versionsResponse = await fetch(versionsUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(versionsResponse.status, 200);
    const versions = await readJson(versionsResponse);
    assert.deepEqual(
      versions.versions.map((version) => [version.sequence, version.isCurrent]),
      [[2, true], [1, false]],
    );

    const versionUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/versions/1`, server.baseUrl);
    const versionResponse = await fetch(versionUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(versionResponse.status, 200);
    const versionOne = await readJson(versionResponse);
    assert.equal(versionOne.version.sequence, 1);
    assert.equal(versionOne.data.name, "Alpha");

    const restoreUrl = new URL(`/api/tateside/schematics/${created.schematic.id}/restore`, server.baseUrl);
    const restoreResponse = await fetch(restoreUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        sequence: 1,
        source: "route-test-restore",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await readJson(restoreResponse);
    assert.equal(restored.version.sequence, 3);
    assert.equal(restored.data.name, "Alpha");
    assert.equal(restored.version.source, "route-test-restore");
    assert.equal(restored.schematic.updatedByEmail, accessEmail);

    const invalidBodyResponse = await fetch(listUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify([]),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invalidBodyResponse.status, 400);
    assert.deepEqual(await readJson(invalidBodyResponse), {
      error: "Request body must be a JSON object",
    });

    const invalidSequenceResponse = await fetch(
      new URL(`/api/tateside/schematics/${created.schematic.id}/versions/not-a-number`, server.baseUrl),
      {
        headers: {
          "Cf-Access-Authenticated-User-Email": accessEmail,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(invalidSequenceResponse.status, 400);
    assert.deepEqual(await readJson(invalidSequenceResponse), {
      error: "sequence must be a positive safe integer",
    });
  } finally {
    await server.stop();
  }
});

test("import normalization routes resolve scoped rules only when staging flag is enabled", async () => {
  const server = await startServer({
    TATESIDE_IMPORT_NORMALIZATION_ENABLED: "1",
  });

  try {
    const rulesUrl = new URL("/api/tateside/import-normalization-rules", server.baseUrl);
    const createManufacturerRule = await fetch(rulesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        fieldKind: "connectorType",
        rawValue: "3.5mm",
        manufacturer: "Bose Professional",
        canonicalValue: "trs-eighth",
        scope: "manufacturer",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createManufacturerRule.status, 201);

    const createModelRule = await fetch(rulesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        fieldKind: "signalType",
        rawValue: "digital-video",
        manufacturer: "AIDA",
        modelNumber: "HD-NDI-200",
        canonicalValue: "ndi",
        scope: "model",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createModelRule.status, 201);

    const createDeviceTypeRule = await fetch(rulesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        fieldKind: "deviceType",
        rawValue: "camera-head",
        manufacturer: "AIDA",
        canonicalValue: "camera",
        scope: "manufacturer",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createDeviceTypeRule.status, 201);

    const resolveUrl = new URL("/api/tateside/import-normalization-rules/resolve", server.baseUrl);
    const resolveResponse = await fetch(resolveUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        templates: [
          {
            id: "import-1",
            label: "Bose CSP-428",
            manufacturer: "Bose Professional",
            modelNumber: "CSP-428",
            deviceType: "audio-dsp",
            ports: [
              { id: "p1", label: "AUX IN", signalType: "analog-audio", connectorType: "3.5mm", direction: "input" },
            ],
          },
          {
            id: "import-2",
            label: "AIDA HD-NDI-200",
            manufacturer: "AIDA",
            modelNumber: "HD-NDI-200",
            deviceType: "camera-head",
            category: "Uncategorized",
            ports: [
              { id: "p1", label: "HDMI OUT", signalType: "digital-video", connectorType: "hdmi", direction: "output" },
            ],
          },
          {
            id: "import-3",
            label: "Other Device",
            manufacturer: "Other",
            modelNumber: "X1",
            deviceType: "camera",
            ports: [
              { id: "p1", label: "Out", signalType: "digital-video", connectorType: "3.5mm", direction: "output" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(resolveResponse.status, 200);
    const resolution = await readJson(resolveResponse);
    assert.equal(resolution.templates[0].ports[0].connectorType, "trs-eighth");
    assert.equal(resolution.templates[0].ports[0].importNormalization.rawConnectorType, "3.5mm");
    assert.equal(resolution.templates[1].ports[0].signalType, "ndi");
    assert.equal(resolution.templates[1].ports[0].importNormalization.rawSignalType, "digital-video");
    assert.equal(resolution.templates[1].deviceType, "camera");
    assert.equal(resolution.templates[1].importNormalization.rawDeviceType, "camera-head");
    assert.equal(resolution.templates[2].ports[0].connectorType, "3.5mm");
    assert.equal(resolution.templates[2].ports[0].signalType, "digital-video");
    assert.deepEqual(
      resolution.unresolved.map((item) => [item.fieldKind, item.rawValue, item.manufacturer ?? null]),
      [
        ["connectorType", "3.5mm", "Other"],
        ["signalType", "digital-video", "Other"],
      ],
    );
    assert.equal(resolution.templates[1].category, "Sources");
  } finally {
    await server.stop();
  }
});

test("import normalization rule deletion keeps immutable audit history", async () => {
  const server = await startServer({
    TATESIDE_IMPORT_NORMALIZATION_ENABLED: "1",
  });

  try {
    const rulesUrl = new URL("/api/tateside/import-normalization-rules", server.baseUrl);
    const createResponse = await fetch(rulesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        fieldKind: "connectorType",
        rawValue: "Euroblock",
        canonicalValue: "phoenix",
        scope: "global",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createResponse.status, 201);
    const created = await readJson(createResponse);

    const deleteResponse = await fetch(
      new URL(`/api/tateside/import-normalization-rules/${created.rule.id}`, server.baseUrl),
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Authenticated-User-Email": accessEmail,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(deleteResponse.status, 204);

    const listResponse = await fetch(rulesUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(listResponse.status, 200);
    const listed = await readJson(listResponse);
    assert.equal(listed.rules.some((rule) => rule.id === created.rule.id), false);

    const db = new DatabaseSync(path.join(server.dataDir, "tateside.db"));
    try {
      const indexList = db.prepare(`
        PRAGMA index_list('import_normalization_rule_audit_log')
      `).all();
      const auditIndex = indexList.find((index) => index.name === "idx_import_normalization_rule_audit_rule_id");
      assert.ok(auditIndex, "expected idx_import_normalization_rule_audit_rule_id to exist");

      const indexColumns = db.prepare(`
        PRAGMA index_info('idx_import_normalization_rule_audit_rule_id')
      `).all();
      assert.deepEqual(
        indexColumns.map((column) => column.name),
        ["rule_id", "created_at"],
      );

      const auditRows = db.prepare(`
        SELECT action, details_json
        FROM import_normalization_rule_audit_log
        WHERE rule_id = ?
        ORDER BY created_at ASC
      `).all(created.rule.id);
      assert.equal(auditRows.length, 2);
      assert.equal(auditRows.at(-1).action, "delete");
      const details = JSON.parse(auditRows.at(-1).details_json);
      assert.equal(details.deletedRule.id, created.rule.id);
      assert.equal(details.deletedRule.canonicalValue, "phoenix");
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
  }
});

test("import normalization routes stay hidden when the staging flag is off", async () => {
  const server = await startServer();

  try {
    const response = await fetch(new URL("/api/tateside/import-normalization-rules", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await readJson(response), {
      error: "Import normalization is not enabled",
    });
  } finally {
    await server.stop();
  }
});

test("library audit route stays hidden when the staging flag is off", async () => {
  const server = await startServer();

  try {
    const response = await fetch(new URL("/api/tateside/library/audit", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await readJson(response), {
      error: "Library audit is not enabled",
    });
  } finally {
    await server.stop();
  }
});

test("library audit route returns a structured report and filters", async () => {
  const server = await startServer({
    TATESIDE_LIBRARY_AUDIT_ENABLED: "1",
  });

  try {
    const templatesUrl = new URL("/api/tateside/devices/templates", server.baseUrl);
    const saveResponse = await fetch(templatesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        templates: [
          {
            label: "Mystery Switch",
            manufacturer: "Unknown",
            modelNumber: "",
            deviceType: "other",
            category: "",
            ports: [
              { id: "p1", label: "Port", direction: "sideways", signalType: "network", connectorType: "euroblock" },
              { id: "p2", label: "Port", direction: "output", signalType: "custom", connectorType: "other" },
            ],
          },
          {
            label: "Clean Camera",
            manufacturer: "AIDA",
            modelNumber: "HD-NDI-200",
            deviceType: "camera",
            heightMm: 45,
            ports: [
              { id: "p1", label: "HDMI Out", direction: "output", signalType: "hdmi", connectorType: "hdmi" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(saveResponse.status, 201);

    const auditUrl = new URL("/api/tateside/library/audit", server.baseUrl);
    const auditResponse = await fetch(auditUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(auditResponse.status, 200);
    const report = await readJson(auditResponse);
    assert.equal(report.totalTemplatesScanned, 2);
    assert.ok(report.totalIssues > 0);
    assert.equal(report.countsByCode.MISSING_MODEL, 1);
    assert.equal(report.countsByCode.INVALID_PORT_DIRECTION, 1);
    assert.equal(report.countsByCode.INVALID_SIGNAL_TYPE, 1);
    assert.equal(report.countsByCode.INVALID_CONNECTOR_TYPE, 1);
    assert.ok(report.affectedTemplates.some((template) => template.manufacturer === "Unknown"));
    assert.ok(report.issues.every((issue) => issue.code && issue.severity && issue.templateId && issue.message && issue.suggestion));
    assert.equal(report.scope.issueFiltersApplied, false);
    assert.equal(report.drilldown.affectedPorts.length > 0, true);

    const filteredUrl = new URL("/api/tateside/library/audit", server.baseUrl);
    filteredUrl.searchParams.set("manufacturer", "Unknown");
    filteredUrl.searchParams.set("severity", "error");
    filteredUrl.searchParams.set("code", "INVALID_PORT_DIRECTION");
    const filteredResponse = await fetch(filteredUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(filteredResponse.status, 200);
    const filtered = await readJson(filteredResponse);
    assert.equal(filtered.totalTemplatesScanned, 2);
    assert.equal(filtered.totalIssues, 1);
    assert.equal(filtered.issues[0].code, "INVALID_PORT_DIRECTION");
    assert.deepEqual(filtered.filtersApplied, {
      code: "INVALID_PORT_DIRECTION",
      severity: "error",
      manufacturer: "Unknown",
    });
    assert.equal(filtered.scope.issuesAfterFilters, 1);
    assert.equal(filtered.issueGroups.length, 1);
    assert.equal(filtered.templateSummaries.length, 1);

    const euroblockUrl = new URL("/api/tateside/library/audit", server.baseUrl);
    euroblockUrl.searchParams.set("code", "INVALID_CONNECTOR_TYPE");
    euroblockUrl.searchParams.set("manufacturer", "Unknown");
    euroblockUrl.searchParams.set("currentValue", "euroblock");
    const euroblockResponse = await fetch(euroblockUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(euroblockResponse.status, 200);
    const euroblock = await readJson(euroblockResponse);
    assert.equal(euroblock.totalIssues, 1);
    assert.equal(euroblock.issueGroups[0].currentValue, "euroblock");
    assert.equal(euroblock.drilldown.affectedPorts[0].portLabel, "Port");

    const unknownFilterUrl = new URL("/api/tateside/library/audit", server.baseUrl);
    unknownFilterUrl.searchParams.set("code", "NOT_A_CODE");
    unknownFilterUrl.searchParams.set("severity", "bad-severity");
    const unknownFilterResponse = await fetch(unknownFilterUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unknownFilterResponse.status, 200);
    const unknownFilter = await readJson(unknownFilterResponse);
    assert.equal(unknownFilter.scope.issueFiltersApplied, true);
    assert.equal(unknownFilter.totalIssues, 0);
    assert.deepEqual(unknownFilter.issues, []);
  } finally {
    await server.stop();
  }
});

test("taxonomy routes expose read-only vocabularies, aliases, inspection, and preview", async () => {
  const server = await startServer();

  try {
    const templatesUrl = new URL("/api/tateside/devices/templates", server.baseUrl);
    const saveResponse = await fetch(templatesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        templates: [
          {
            label: "Legacy Camera",
            manufacturer: "AIDA",
            modelNumber: "HD-100",
            deviceType: "camera",
            category: "Sources",
            ports: [
              { id: "p1", label: "HDMI Out", direction: "output", signalType: "hdmi", connectorType: "hdmi" },
            ],
          },
          {
            label: "Candidate DSP",
            manufacturer: "Bose",
            modelNumber: "EX-1280",
            deviceType: "audio-dsp",
            category: "Audio",
            roleTags: ["dsp", "av-over-ip"],
            deviceCapabilities: ["audio-processing"],
            protocols: ["dante"],
            reviewStatus: "needs-review",
            classificationConfidence: "medium",
            evidenceRefs: [
              {
                type: "trusted-human-note",
                title: "Manual review seed",
                note: "Read-only taxonomy foundation coverage.",
                capturedAt: "2026-07-09T10:00:00Z",
              },
            ],
            lastReviewedBy: "route-test@example.com",
            lastReviewedAt: "2026-07-09T10:00:00Z",
            ports: [
              { id: "p1", label: "Dante Primary", direction: "bidirectional", signalType: "dante", connectorType: "rj45" },
              { id: "p2", label: "GPIO", direction: "input", signalType: "gpio", connectorType: "terminal-block" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(saveResponse.status, 201);

    const saved = await readJson(saveResponse);
    assert.equal(saved.templates.length, 2);

    const vocabResponse = await fetch(new URL("/api/tateside/taxonomy/vocabularies", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(vocabResponse.status, 200);
    const vocabularies = await readJson(vocabResponse);
    assert.ok(vocabularies.categories.includes("Audio"));
    assert.ok(vocabularies.deviceTypes.some((entry) => entry.value === "audio-dsp"));
    assert.ok(vocabularies.roleTags.includes("dsp"));
    assert.ok(vocabularies.deviceCapabilities.includes("audio-processing"));
    assert.ok(vocabularies.protocols.includes("dante"));

    const aliasResponse = await fetch(new URL("/api/tateside/taxonomy/aliases", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(aliasResponse.status, 200);
    const aliases = await readJson(aliasResponse);
    assert.ok(aliases.entries.some((entry) => entry.field === "connectorType" && entry.canonicalValue === "terminal-block"));
    assert.ok(aliases.entries.some((entry) => entry.field === "roleTags" && entry.canonicalValue === "avoip"));

    const inspectResponse = await fetch(new URL("/api/tateside/taxonomy/inspect", server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        template: saved.templates[1],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(inspectResponse.status, 200);
    const inspection = await readJson(inspectResponse);
    assert.equal(inspection.readOnly, true);
    assert.equal(inspection.deviceType.known, true);
    assert.deepEqual(inspection.template.deviceCapabilities.values, ["audio-processing"]);
    assert.equal(inspection.template.reviewStatus, "needs-review");
    assert.equal(inspection.template.classificationConfidence, "medium");
    assert.equal(inspection.template.evidenceRefCount, 1);
    assert.ok(inspection.aliasMatches.some((match) => match.field === "roleTags" && match.canonicalValue === "avoip"));

    const beforePreviewList = await fetch(templatesUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const beforePreviewTemplates = await readJson(beforePreviewList);
    assert.equal(beforePreviewTemplates.length, 2);

    const previewResponse = await fetch(new URL("/api/tateside/taxonomy/proposals/preview", server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        template: {
          label: "Preview Amp",
          manufacturer: "QSC",
          modelNumber: "Amp 8",
          deviceType: "amplifier",
          category: "Audio",
          ports: [
            { id: "p1", label: "Speaker Out", direction: "output", signalType: "speaker-level", connectorType: "terminal-block" },
            { id: "p2", label: "Telephone Line", direction: "bidirectional", signalType: "analog-audio", connectorType: "rj11" },
          ],
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await readJson(previewResponse);
    assert.equal(preview.readOnly, true);
    assert.ok(preview.proposals.some((proposal) => proposal.field === "category" && proposal.value === "Amplifiers"));
    assert.ok(preview.proposals.some((proposal) => proposal.field === "roleTags" && proposal.value === "amplifier"));
    assert.ok(preview.proposals.some((proposal) => proposal.field === "deviceCapabilities" && proposal.value === "amplification"));
    assert.ok(preview.proposals.some((proposal) => proposal.field === "protocols" && proposal.value === "pstn"));

    const afterPreviewList = await fetch(templatesUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const afterPreviewTemplates = await readJson(afterPreviewList);
    assert.equal(afterPreviewTemplates.length, 2);

    const invalidInspectResponse = await fetch(new URL("/api/tateside/taxonomy/inspect", server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        template: {
          label: "Broken",
          deviceType: "camera",
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invalidInspectResponse.status, 400);
    const invalidInspect = await readJson(invalidInspectResponse);
    assert.match(invalidInspect.error, /template is invalid/i);

    const invalidPreviewResponse = await fetch(new URL("/api/tateside/taxonomy/proposals/preview", server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        template: "not-an-object",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invalidPreviewResponse.status, 400);
    const invalidPreview = await readJson(invalidPreviewResponse);
    assert.match(invalidPreview.error, /template must be a json object/i);
  } finally {
    await server.stop();
  }
});

test("library doctor routes are hidden when feature flag is off", async () => {
  const server = await startServer();

  try {
    const response = await fetch(new URL("/api/tateside/library-doctor/proposals", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await readJson(response), {
      error: "Library Doctor is not enabled",
    });
  } finally {
    await server.stop();
  }
});

test("library doctor proposal queue create, list, filter, review, history, and no apply path", async () => {
  const server = await startServer({
    TATESIDE_LIBRARY_DOCTOR_ENABLED: "1",
  });

  try {
    const templatesUrl = new URL("/api/tateside/devices/templates", server.baseUrl);
    const saveResponse = await fetch(templatesUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        templates: [
          {
            label: "QSC SPA2-60",
            manufacturer: "QSC",
            modelNumber: "SPA2-60",
            deviceType: "amplifier",
            ports: [
              {
                id: "p1",
                label: "Line In",
                direction: "input",
                signalType: "analog-audio",
                connectorType: "euroblock",
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(saveResponse.status, 201);
    const saved = await readJson(saveResponse);
    const templateId = saved.templates[0].id;
    const beforeTemplates = structuredClone(saved.templates);

    const proposalsUrl = new URL("/api/tateside/library-doctor/proposals", server.baseUrl);
    const createResponse = await fetch(proposalsUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        templateId,
        manufacturer: "QSC",
        modelNumber: "SPA2-60",
        sourceIssueCode: "INVALID_CONNECTOR_TYPE",
        sourceIssueGroup: "connector",
        sourceCurrentValue: "euroblock",
        field: "connectorType",
        currentValue: "euroblock",
        proposedValue: "terminal-block",
        proposalType: "alias-normalization",
        confidence: "medium",
        risk: "high",
        evidenceRefs: [
          {
            type: "taxonomy-alias",
            title: "terminal-block aliases",
            note: "High-risk connector alias",
          },
        ],
        rationale: "Canonicalize euroblock after human review",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(createResponse.status, 201);
    const created = await readJson(createResponse);
    assert.equal(created.proposal.status, "pending");
    assert.equal(created.proposal.createdBy, accessEmail);
    assert.equal(created.proposal.preview.readOnly, true);
    assert.equal(created.proposal.preview.currentValue, "euroblock");
    assert.equal(created.proposal.preview.proposedValue, "terminal-block");
    const proposalId = created.proposal.id;

    const listResponse = await fetch(proposalsUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(listResponse.status, 200);
    const listed = await readJson(listResponse);
    assert.equal(listed.proposals.length, 1);

    const filteredUrl = new URL("/api/tateside/library-doctor/proposals", server.baseUrl);
    filteredUrl.searchParams.set("status", "pending");
    filteredUrl.searchParams.set("manufacturer", "QSC");
    filteredUrl.searchParams.set("field", "connectorType");
    filteredUrl.searchParams.set("proposalType", "alias-normalization");
    filteredUrl.searchParams.set("confidence", "medium");
    filteredUrl.searchParams.set("risk", "high");
    filteredUrl.searchParams.set("sourceIssueCode", "INVALID_CONNECTOR_TYPE");
    filteredUrl.searchParams.set("templateId", templateId);
    const filteredResponse = await fetch(filteredUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(filteredResponse.status, 200);
    const filtered = await readJson(filteredResponse);
    assert.equal(filtered.proposals.length, 1);

    const getResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}`, server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(getResponse.status, 200);
    const got = await readJson(getResponse);
    assert.equal(got.proposal.id, proposalId);

    const missingResponse = await fetch(new URL("/api/tateside/library-doctor/proposals/missing-id", server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await readJson(missingResponse), { error: "Proposal not found" });

    const badCreateResponse = await fetch(proposalsUrl, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        field: "connectorType",
        proposalType: "not-a-type",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(badCreateResponse.status, 400);

    const reviewResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}/review`, server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        status: "accepted",
        reviewNote: "Approved in review queue only",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(reviewResponse.status, 200);
    const reviewed = await readJson(reviewResponse);
    assert.equal(reviewed.proposal.status, "accepted");
    assert.equal(reviewed.proposal.reviewedBy, accessEmail);
    assert.equal(reviewed.proposal.reviewNote, "Approved in review queue only");

    // Accepted must not mutate the real template library.
    const afterAcceptTemplatesResponse = await fetch(templatesUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(afterAcceptTemplatesResponse.status, 200);
    const afterAcceptTemplates = await readJson(afterAcceptTemplatesResponse);
    assert.equal(afterAcceptTemplates[0].ports[0].connectorType, "euroblock");
    assert.equal(afterAcceptTemplates[0].ports[0].connectorType, beforeTemplates[0].ports[0].connectorType);

    const badTransitionResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}/review`, server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        status: "rejected",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(badTransitionResponse.status, 409);
    assert.match((await readJson(badTransitionResponse)).error, /Invalid status transition/);

    const historyResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}/history`, server.baseUrl), {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(historyResponse.status, 200);
    const history = await readJson(historyResponse);
    assert.equal(history.history.length, 2);
    assert.equal(history.history[0].eventType, "created");
    assert.equal(history.history[1].oldStatus, "pending");
    assert.equal(history.history[1].newStatus, "accepted");

    // Explicitly confirm there is no apply endpoint.
    const applyResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}/apply`, server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(applyResponse.status, 404);

    const supersedeResponse = await fetch(new URL(`/api/tateside/library-doctor/proposals/${proposalId}/supersede`, server.baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        reviewNote: "Superseded by refined mapping",
        replacement: {
          templateId,
          manufacturer: "QSC",
          modelNumber: "SPA2-60",
          field: "connectorType",
          currentValue: "euroblock",
          proposedValue: "phoenix",
          proposalType: "alias-normalization",
          confidence: "low",
          risk: "high",
          rationale: "Vendor-specific labeling",
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(supersedeResponse.status, 200);
    const superseded = await readJson(supersedeResponse);
    assert.equal(superseded.proposal.status, "superseded");
    assert.equal(superseded.replacement.status, "pending");
    assert.equal(superseded.replacement.supersedesProposalId, proposalId);
    assert.equal(superseded.replacement.proposedValue, "phoenix");

    const finalTemplatesResponse = await fetch(templatesUrl, {
      headers: {
        "Cf-Access-Authenticated-User-Email": accessEmail,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const finalTemplates = await readJson(finalTemplatesResponse);
    assert.equal(finalTemplates[0].ports[0].connectorType, "euroblock");
  } finally {
    await server.stop();
  }
});
