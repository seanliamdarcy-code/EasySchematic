import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import {
  createJetbuiltGetOnlyFetch,
  fetchJetbuiltPagedCollection,
  jetbuiltGetJson,
} from "../dist-tateside-api/tateside-api/src/jetbuilt.js";
import {
  createSyncRun,
  failSyncRun,
  getDeviceUsageHistory,
  getHistoryCoverage,
  getRoomBom,
  getRoomDeviceCooccurrence,
  getUnmatchedHistoryLines,
  ingestHistoryProject,
  matchHistoryTemplates,
  openJetbuiltHistoryDatabase,
  runJetbuiltHistoryMigrations,
  searchHistoryProjects,
} from "../dist-tateside-api/tateside-api/src/jetbuiltHistoryStore.js";
import { getJetbuiltCohortSemantics, isProjectInJetbuiltCohort } from "../dist-tateside-api/tateside-api/src/jetbuiltHistoryCohorts.js";
import {
  classifyJetbuiltHistoryLine,
  findSimilarRooms,
  findSimilarSystems,
  getClientRoomPatterns,
  getCommonRoomBomPatterns,
  getCommonSystemBomPatterns,
  getHistoricalLineClassificationSummary,
  getHistoryCanonicalMatchCoverage,
  getHistoryRoomDeviceCooccurrence,
  getJetbuiltHistoryDataQuality,
  getManufacturerUsageTrends,
  getModelUsageTrends,
  getRoomBomFingerprint,
  getSystemBom,
  JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
  jetbuiltSchematicRelevanceV1RuleCount,
  listJetbuiltSchematicRelevanceV1Rules,
  summarizeRepeatedPatterns,
} from "../dist-tateside-api/tateside-api/src/jetbuiltHistoryIntelligence.js";
import { selectStratifiedHistoryProjectIds, syncJetbuiltHistory, validateHistoryBounds } from "../dist-tateside-api/tateside-api/src/jetbuiltHistorySync.js";
import {
  getJetbuiltCandidateCooccurrence,
  getJetbuiltCandidateUsage,
  getJetbuiltLibraryCandidate,
  getJetbuiltLibraryCandidates,
  getJetbuiltLibraryCoverageSummary,
  scoreJetbuiltDiscoveryCandidate,
} from "../dist-tateside-api/tateside-api/src/jetbuiltLibraryDiscovery.js";
import { createMcpLibraryTools } from "../dist-tateside-api/tateside-api/src/mcpLibrary.js";
import { createTateSideMcpServer } from "../dist-tateside-api/tateside-api/src/mcpServer.js";
import { createLibraryDoctorNewTemplateProposal } from "../dist-tateside-api/tateside-api/src/libraryDoctorNewTemplate.js";
import {
  getJetbuiltProjectLibraryGapAnalysis,
  getJetbuiltProjectLibraryGapAnalysisWithAcquisition,
  JetbuiltProjectGapError,
} from "../dist-tateside-api/tateside-api/src/jetbuiltProjectLibraryGap.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "jetbuilt-history-project.json"), "utf8"));

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "jetbuilt-history-"));
  const db = openJetbuiltHistoryDatabase(path.join(dir, "history.db"));
  runJetbuiltHistoryMigrations(db);
  return { db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function fixtureFetch({ failProjectId, paged = false } = {}) {
  return async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    if (failProjectId && url.pathname === `/api/projects/${failProjectId}`) return response("failure", 500);
    if (url.pathname === "/api/projects") {
      if (url.searchParams.get("page") === "2") return response({ projects: [{ id: "7002" }] });
      const headers = paged ? { Link: `<${url.origin}${url.pathname}?page=2>; rel="next"` } : {};
      return response({ projects: [{ id: "7001" }] }, 200, headers);
    }
    const match = url.pathname.match(/^\/api\/projects\/(\d+)(?:\/(rooms|systems|items|versions))?$/);
    if (!match) return response({ error: "not found" }, 404);
    const id = Number(match[1]);
    if (!match[2]) return response({ ...fixture.project, id });
    return response({ [match[2]]: fixture[match[2]] });
  };
}

function intelligenceBundle({ projectId, clientId, stage, roomId, systemId, displayQuantity, reverse = false, includeZero = false, createdAt, updatedAt }) {
  const items = [
    { id: `${projectId}-display`, manufacturer_name: reverse ? " ACME " : "Acme", model: reverse ? " Display 55 " : "Display-55", quantity: displayQuantity, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
    { id: `${projectId}-dsp`, manufacturer_name: reverse ? " acme" : "Acme", model: reverse ? " dsp 1 " : "DSP-1", quantity: 1, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
  ];
  if (includeZero) items.push({ id: `${projectId}-aux`, manufacturer_name: "Acme", model: "Aux-1", quantity: 0, room: { id: roomId }, system: { id: systemId }, created_at: createdAt });
  if (reverse) items.reverse();
  return {
    project: { id: projectId, client: { id: clientId }, stage, created_at: createdAt, updated_at: updatedAt ?? createdAt },
    rooms: [{ id: roomId, created_at: createdAt, updated_at: updatedAt ?? createdAt }],
    systems: [{ id: systemId, created_at: createdAt, updated_at: updatedAt ?? createdAt }],
    items,
  };
}

function internalOnlyBundle({ projectId, clientId, stage, roomId, systemId, createdAt, manufacturer = "Tateside", model = "Installation", quantity = 1 }) {
  return {
    project: { id: projectId, client: { id: clientId }, stage, created_at: createdAt, updated_at: createdAt },
    rooms: [{ id: roomId, created_at: createdAt, updated_at: createdAt }],
    systems: [{ id: systemId, created_at: createdAt, updated_at: createdAt }],
    items: [
      { id: `${projectId}-internal`, manufacturer_name: manufacturer, model, quantity, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
    ],
  };
}

function mixedDeviceAndInternalBundle({ projectId, clientId, stage, roomId, systemId, createdAt, reverse = false }) {
  const items = [
    { id: `${projectId}-display`, manufacturer_name: "Acme", model: "Display-55", quantity: 1, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
    { id: `${projectId}-install`, manufacturer_name: reverse ? "Tateside -" : "Tateside", model: "Installation", quantity: 2, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
    { id: `${projectId}-unknown`, manufacturer_name: "Logitech", model: "Meetup", quantity: 1, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
  ];
  if (reverse) items.reverse();
  return {
    project: { id: projectId, client: { id: clientId }, stage, created_at: createdAt, updated_at: createdAt },
    rooms: [{ id: roomId, created_at: createdAt, updated_at: createdAt }],
    systems: [{ id: systemId, created_at: createdAt, updated_at: createdAt }],
    items,
  };
}

test("separate database migrations and fixture relationships", () => {
  const { db, close } = tempDb();
  try {
    assert.deepEqual(runJetbuiltHistoryMigrations(db), []);
    const run = createSyncRun(db, "fixture", { projectIds: ["7001"] });
    ingestHistoryProject(db, run, fixture);
    assert.deepEqual(getHistoryCoverage(db), {
      projectCount: 1, clientCount: 1, roomCount: 2, systemCount: 2, lineItemCount: 5,
      distinctManufacturers: 2, distinctModels: 5,
      earliestProjectCreatedAt: "2025-01-02T09:00:00Z", latestProjectCreatedAt: "2025-01-02T09:00:00Z",
      earliestProjectUpdatedAt: "2025-02-03T10:00:00Z", latestProjectUpdatedAt: "2025-02-03T10:00:00Z",
      canonicalMatchCount: 0, unmatchedCount: 5, invalidOrNonPositiveQuantityCount: 3,
    });
    assert.equal(db.prepare("SELECT count(*) count FROM line_items WHERE room_id IS NOT NULL AND system_id IS NOT NULL").get().count, 5);
    assert.deepEqual(db.prepare("SELECT quantity_raw, quantity_numeric, quantity_state FROM line_items ORDER BY jetbuilt_id").all().slice(2).map((row) => ({ ...row })), [
      { quantity_raw: "0", quantity_numeric: 0, quantity_state: "zero" },
      { quantity_raw: "-2", quantity_numeric: -2, quantity_state: "negative" },
      { quantity_raw: "not-a-number", quantity_numeric: null, quantity_state: "malformed" },
    ]);
  } finally { close(); }
});

test("immutable snapshots are idempotent and retain changed payload versions", () => {
  const { db, close } = tempDb();
  try {
    ingestHistoryProject(db, createSyncRun(db, "fixture", {}), fixture);
    const initial = db.prepare("SELECT count(*) count FROM raw_snapshots").get().count;
    ingestHistoryProject(db, createSyncRun(db, "fixture", {}), fixture);
    assert.equal(db.prepare("SELECT count(*) count FROM raw_snapshots").get().count, initial);
    assert.equal(db.prepare("SELECT count(*) count FROM projects").get().count, 1);
    const changed = structuredClone(fixture);
    changed.items[0].quantity = 3;
    changed.items[0].updated_at = "2025-02-04T10:00:00Z";
    ingestHistoryProject(db, createSyncRun(db, "fixture", {}), changed);
    assert.equal(db.prepare("SELECT count(*) count FROM raw_snapshots").get().count, initial + 1);
    assert.equal(db.prepare("SELECT quantity_numeric FROM line_items WHERE jetbuilt_id='7301'").get().quantity_numeric, 3);
  } finally { close(); }
});

test("failed sync status does not disturb prior source truth", () => {
  const { db, close } = tempDb();
  try {
    ingestHistoryProject(db, createSyncRun(db, "fixture", {}), fixture);
    const before = db.prepare("SELECT count(*) count FROM raw_snapshots").get().count;
    const failed = createSyncRun(db, "fixture", {});
    failSyncRun(db, failed, new Error("redacted failure"));
    assert.equal(db.prepare("SELECT status FROM sync_runs WHERE id=?").get(failed).status, "failed");
    assert.equal(db.prepare("SELECT count(*) count FROM raw_snapshots").get().count, before);
  } finally { close(); }
});

test("bounded sync rejects unsafe input and enforces maximum", () => {
  assert.throws(() => validateHistoryBounds({}), /required/);
  assert.equal(validateHistoryBounds({ minUpdatedAt: "2025-01-01" }).maxProjectCount, 25);
  assert.equal(validateHistoryBounds({ maxProjectCount: 1 }).maxProjectCount, 1);
  assert.throws(() => validateHistoryBounds({ projectIds: ["1", "2"], maxProjectCount: 1 }), /exceeds/);
  assert.throws(() => validateHistoryBounds({ projectIds: ["1"], maxProjectCount: 101 }), /1 to 100/);
  assert.throws(() => validateHistoryBounds({ projectIds: ["1"], minCreatedAt: "bad" }), /ISO-compatible/);
});

test("GET-only wrapper rejects before network", async () => {
  let calls = 0;
  const getOnly = createJetbuiltGetOnlyFetch(async () => { calls += 1; return response({}); });
  assert.throws(() => getOnly("https://example.test", { method: "POST" }), /only permits GET/);
  assert.equal(calls, 0);
});

test("finite retry, Retry-After, 5xx ceiling, credentials and malformed JSON", async () => {
  let calls = 0;
  const waits = [];
  const retrying = async () => { calls += 1; return calls === 1 ? response({}, 429, { "Retry-After": "2" }) : response({ ok: true }); };
  assert.deepEqual(await jetbuiltGetJson("https://example.test", {
    apiKey: "test", indexPath: "", refreshMs: 0, fetchImpl: retrying, sleepImpl: async (ms) => { waits.push(ms); },
  }), { ok: true });
  assert.equal(calls, 2);
  assert.ok(waits.includes(2000));

  calls = 0;
  await assert.rejects(jetbuiltGetJson("https://example.test", {
    apiKey: "test", indexPath: "", refreshMs: 0, maxRetries: 2,
    fetchImpl: async () => { calls += 1; return response("down", 503); }, sleepImpl: async () => {},
  }), /503/);
  assert.equal(calls, 3);
  await assert.rejects(jetbuiltGetJson("https://example.test", { apiKey: "", indexPath: "", refreshMs: 0 }), /not configured/);
  await assert.rejects(jetbuiltGetJson("https://example.test", {
    apiKey: "test", indexPath: "", refreshMs: 0, fetchImpl: async () => response("not json"), sleepImpl: async () => {},
  }), /malformed JSON/);
});

test("pagination traverses Link rel=next deterministically", async () => {
  let calls = 0;
  const fetchImpl = fixtureFetch({ paged: true });
  const rows = await fetchJetbuiltPagedCollection("https://example.test/api/projects", {
    apiKey: "test", indexPath: "", refreshMs: 0, fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); }, sleepImpl: async () => {},
  });
  assert.deepEqual(rows.map((row) => row.id), ["7001", "7002"]);
  calls = 0;
  const bounded = await fetchJetbuiltPagedCollection("https://example.test/api/projects", {
    apiKey: "test", indexPath: "", refreshMs: 0, fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); }, sleepImpl: async () => {},
  }, 1);
  assert.deepEqual(bounded.map((row) => row.id), ["7001"]);
  assert.equal(calls, 1);
});

test("sync lifecycle commits completed projects and marks interrupted runs failed", async () => {
  const { db, close } = tempDb();
  try {
    const success = await syncJetbuiltHistory(db, { projectIds: ["7001"] }, {
      apiKey: "test", baseUrl: "https://example.test/api", indexPath: "", refreshMs: 0,
      fetchImpl: fixtureFetch(), sleepImpl: async () => {},
    });
    assert.equal(success.projectCount, 1);
    assert.deepEqual({ ...db.prepare("SELECT status, request_count FROM sync_runs WHERE id=?").get(success.syncRunId) }, { status: "completed", request_count: 5 });

    await assert.rejects(syncJetbuiltHistory(db, { projectIds: ["7003", "7004"] }, {
      apiKey: "test", baseUrl: "https://example.test/api", indexPath: "", refreshMs: 0, maxRetries: 0,
      fetchImpl: fixtureFetch({ failProjectId: "7004" }), sleepImpl: async () => {},
    }), /500/);
    const failed = db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get();
    assert.equal(failed.status, "failed");
    assert.equal(db.prepare("SELECT count(*) count FROM projects WHERE jetbuilt_id='7003'").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) count FROM projects WHERE jetbuilt_id='7004'").get().count, 0);

    await assert.rejects(syncJetbuiltHistory(db, { projectIds: ["7005"] }, {
      apiKey: "", baseUrl: "https://example.test/api", indexPath: "", refreshMs: 0,
    }), /not configured/);
    assert.equal(db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get().status, "failed");
  } finally { close(); }
});

test("exact canonical matching is read-only and queries are paginated/deterministic", () => {
  const history = tempDb();
  const canonicalDir = mkdtempSync(path.join(tmpdir(), "jetbuilt-canonical-"));
  const canonical = openDatabase(path.join(canonicalDir, "canonical.db"));
  try {
    runMigrations(canonical);
    saveTemplates(canonical, { templates: [
      { label: "Acme Display", manufacturer: "Acme", modelNumber: "Display-55", deviceType: "display", category: "video", ports: [] },
      { label: "Acme DSP", manufacturer: "Acme", modelNumber: "DSP-1", deviceType: "audio-dsp", category: "audio", ports: [] },
    ] });
    ingestHistoryProject(history.db, createSyncRun(history.db, "fixture", {}), fixture);
    const beforeDevices = canonical.prepare("SELECT count(*) count FROM devices").get().count;
    const beforeTaxonomy = canonical.prepare("SELECT count(*) count FROM taxonomy_registry_values").get().count;
    assert.equal(matchHistoryTemplates(history.db, canonical), 2);
    assert.equal(canonical.prepare("SELECT count(*) count FROM devices").get().count, beforeDevices);
    assert.equal(canonical.prepare("SELECT count(*) count FROM taxonomy_registry_values").get().count, beforeTaxonomy);
    assert.equal(getHistoryCoverage(history.db).unmatchedCount, 3);

    const page = searchHistoryProjects(history.db, { projectName: "collaboration", manufacturer: "Acme", limit: 1 });
    assert.deepEqual({ total: page.total, count: page.count, hasMore: page.hasMore }, { total: 1, count: 1, hasMore: false });
    const usage = getDeviceUsageHistory(history.db, "Acme", "DSP-1");
    assert.deepEqual({ lines: usage.totalMatchingLineItems, quantity: usage.validQuantityTotal, projects: usage.projects }, { lines: 1, quantity: 1.5, projects: 1 });
    assert.equal(getRoomBom(history.db, "7001", "7101").length, 2);
    assert.deepEqual(getRoomDeviceCooccurrence(history.db, { manufacturer: "Acme", model: "Display-55" }).map((row) => row.model_raw), ["DSP-1"]);
    const displayId = history.db.prepare("SELECT canonical_template_id FROM canonical_template_links WHERE line_item_id='7301'").get().canonical_template_id;
    assert.deepEqual(getRoomDeviceCooccurrence(history.db, { canonicalTemplateId: displayId }).map((row) => row.model_raw), ["DSP-1"]);
    assert.deepEqual(getUnmatchedHistoryLines(history.db, 2).items.map((row) => row.model_raw), ["Speaker-1", "Mic-1"]);
  } finally {
    canonical.close();
    rmSync(canonicalDir, { recursive: true, force: true });
    history.close();
  }
});

test("phase 2 cohorts and historical intelligence remain deterministic and read-only", () => {
  const history = tempDb();
  try {
    const run = createSyncRun(history.db, "fixture", {});
    const bundles = [
      intelligenceBundle({ projectId: "8001", clientId: "client-1", stage: "completed", roomId: "8101", systemId: "8201", displayQuantity: 2, createdAt: "2025-01-10T10:00:00Z" }),
      intelligenceBundle({ projectId: "8002", clientId: "client-1", stage: "install", roomId: "8102", systemId: "8202", displayQuantity: 2, reverse: true, createdAt: "2025-06-10T10:00:00Z" }),
      intelligenceBundle({ projectId: "8003", clientId: "client-2", stage: "estimate", roomId: "8103", systemId: "8203", displayQuantity: 3, includeZero: true, createdAt: "2026-01-10T10:00:00Z" }),
      intelligenceBundle({ projectId: "8004", clientId: "client-3", stage: "proposal", roomId: "8104", systemId: "8204", displayQuantity: 3, reverse: true, includeZero: true, createdAt: "2026-04-10T10:00:00Z" }),
    ];
    for (const bundle of bundles) ingestHistoryProject(history.db, run, bundle);
    const link = history.db.prepare("INSERT INTO canonical_template_links(project_id, line_item_id, canonical_template_id, match_method, confidence, matched_at, matcher_version) VALUES (?, ?, 'template-display', 'exact_normalized_manufacturer_model', 'deterministic', ?, 'exact-v1')");
    for (const bundle of bundles) link.run(bundle.project.id, `${bundle.project.id}-display`, "2026-07-11T00:00:00Z");

    assert.equal(isProjectInJetbuiltCohort("completed", "delivered-or-installed"), true);
    assert.equal(isProjectInJetbuiltCohort("unexpected-stage", "non-delivered"), false);
    assert.equal(isProjectInJetbuiltCohort("unexpected-stage", "all"), true);
    assert.equal(getJetbuiltCohortSemantics().find((entry) => entry.cohort === "excluded").includedRawStages[0], "trash");
    assert.deepEqual(selectStratifiedHistoryProjectIds([
      { id: "e1", stage: "estimate", updatedAt: "2025-01-01" }, { id: "e2", stage: "estimate", updatedAt: "2025-01-02" }, { id: "e3", stage: "estimate", updatedAt: "2025-01-03" },
      { id: "c1", stage: "completed", updatedAt: "2025-01-01" }, { id: "c2", stage: "completed", updatedAt: "2025-01-02" },
    ], { estimate: 2, completed: 1 }, 3), ["c2", "e1", "e3"]);
    assert.throws(() => selectStratifiedHistoryProjectIds([{ id: "1", stage: "estimate" }, { id: "2", stage: "completed" }], { estimate: 1, completed: 1 }, 1), /exceeds/);

    const first = getRoomBomFingerprint(history.db, "8001", "8101");
    const reordered = getRoomBomFingerprint(history.db, "8002", "8102");
    const changedQuantity = getRoomBomFingerprint(history.db, "8003", "8103");
    assert.equal(first.fingerprint, reordered.fingerprint);
    assert.equal(first.fullSourceFingerprint, reordered.fullSourceFingerprint);
    assert.notEqual(first.fingerprint, changedQuantity.fingerprint);
    assert.ok(first.entries.some((entry) => entry.identity === "canonical:template-display"));
    assert.ok(first.entries.some((entry) => entry.identity === "raw:acme::dsp1"));

    const roomPatterns = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" });
    assert.equal(roomPatterns.fingerprintMode, "full-source");
    assert.equal(roomPatterns.total, 2);
    assert.deepEqual({ total: roomPatterns.total, count: roomPatterns.count }, { total: 2, count: 2 });
    const roomPatternPage = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source", limit: 1 });
    assert.equal(roomPatternPage.hasMore, true);
    assert.equal(getCommonRoomBomPatterns(history.db, { cohort: "delivered-or-installed", minimumOccurrence: 2, fingerprintMode: "full-source" }).total, 1);
    assert.equal(getClientRoomPatterns(history.db, "client-1", { minimumOccurrence: 2, fingerprintMode: "full-source" }).total, 1);

    const similarRooms = findSimilarRooms(history.db, "8001", "8101");
    assert.equal(similarRooms.items[0].roomId, "8102");
    assert.equal(similarRooms.items[0].exactFingerprintMatch, true);
    assert.equal(similarRooms.items[0].exactFullSourceFingerprintMatch, true);
    assert.equal(similarRooms.items[0].exactSchematicRelevantFingerprintMatch, true);
    assert.ok(similarRooms.items[0].reasons.includes("exact-bom-fingerprint"));
    assert.equal(getSystemBom(history.db, "8001", "8201").fingerprint, getSystemBom(history.db, "8002", "8202").fingerprint);
    assert.equal(getCommonSystemBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" }).total, 2);
    assert.equal(findSimilarSystems(history.db, "8001", "8201").items[0].systemId, "8202");

    const rawCooccurrence = getHistoryRoomDeviceCooccurrence(history.db, { manufacturer: "Acme", model: "Display-55", minimumRoomCount: 2 });
    assert.equal(rawCooccurrence.items.find((entry) => entry.model === "DSP-1").roomCount, 2);
    const cooccurrence = getHistoryRoomDeviceCooccurrence(history.db, { canonicalTemplateId: "template-display", minimumRoomCount: 2 });
    const dsp = cooccurrence.items.filter((entry) => entry.model.replace(/[^a-z0-9]+/gi, "").toLowerCase() === "dsp1");
    assert.deepEqual(dsp.reduce((total, entry) => ({ occurrences: total.occurrences + entry.lineItemOccurrences, rooms: total.rooms + entry.roomCount, projects: total.projects + entry.projectCount }), { occurrences: 0, rooms: 0, projects: 0 }), { occurrences: 4, rooms: 4, projects: 4 });
    assert.equal(getRoomDeviceCooccurrence(history.db, { canonicalTemplateId: "template-display", cohort: "delivered-or-installed", minimumRoomCount: 1 }).length > 0, true);

    const yearTrends = getManufacturerUsageTrends(history.db, { groupBy: "year", dateBasis: "created" });
    assert.equal(yearTrends.groupBy, "year");
    assert.equal(yearTrends.dateBasis, "created");
    assert.ok(yearTrends.items.every((row) => /^\d{4}$/.test(String(row.bucket))));
    assert.ok(yearTrends.items.some((row) => row.bucket === "2025"));
    assert.ok(yearTrends.items.some((row) => row.bucket === "2026"));
    const quarterTrends = getModelUsageTrends(history.db, { groupBy: "quarter", dateBasis: "updated" });
    assert.equal(quarterTrends.dateBasis, "updated");
    assert.equal(quarterTrends.groupBy, "quarter");
    assert.ok(quarterTrends.items.every((row) => /^\d{4}-Q[1-4]$/.test(String(row.bucket))));
    assert.ok(quarterTrends.items.some((row) => row.bucket === "2025-Q1" || row.bucket === "2025-Q2"));

    const before = JSON.stringify(history.db.prepare("SELECT project_id, line_item_id, canonical_template_id FROM canonical_template_links ORDER BY project_id, line_item_id").all());
    const canonicalCoverage = getHistoryCanonicalMatchCoverage(history.db);
    assert.deepEqual({ total: canonicalCoverage.lineItemCount, matched: canonicalCoverage.exactMatchedLineItems, unmatched: canonicalCoverage.unmatchedLineItems }, { total: 10, matched: 4, unmatched: 6 });
    const quality = getJetbuiltHistoryDataQuality(history.db);
    assert.deepEqual({
      projects: quality.projectCount,
      rooms: quality.roomCount,
      systems: quality.systemCount,
      zero: quality.zeroQuantities,
      duplicateRooms: quality.duplicateChildIds.room,
      duplicateSystems: quality.duplicateChildIds.system,
      duplicateLineItems: quality.duplicateChildIds.lineItem,
    }, { projects: 4, rooms: 4, systems: 4, zero: 2, duplicateRooms: 0, duplicateSystems: 0, duplicateLineItems: 0 });
    assert.equal(JSON.stringify(history.db.prepare("SELECT project_id, line_item_id, canonical_template_id FROM canonical_template_links ORDER BY project_id, line_item_id").all()), before);
    assert.deepEqual(getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" }), roomPatterns);
  } finally {
    history.close();
  }
});

test("phase 2 trend date basis and duplicate child-id reporting are explicit", () => {
  const history = tempDb();
  try {
    const run = createSyncRun(history.db, "fixture", {});
    ingestHistoryProject(history.db, run, intelligenceBundle({
      projectId: "9001", clientId: "c-a", stage: "completed", roomId: "9101", systemId: "9201",
      displayQuantity: 1, createdAt: "2024-03-15T10:00:00Z", updatedAt: "2025-11-01T10:00:00Z",
    }));
    ingestHistoryProject(history.db, run, intelligenceBundle({
      projectId: "9002", clientId: "c-b", stage: "install", roomId: "9102", systemId: "9202",
      displayQuantity: 1, createdAt: "2024-08-15T10:00:00Z", updatedAt: "2025-11-01T12:00:00Z",
    }));
    ingestHistoryProject(history.db, run, intelligenceBundle({
      projectId: "9003", clientId: "c-c", stage: "estimate", roomId: "9103", systemId: "9203",
      displayQuantity: 1, createdAt: "2025-02-10T10:00:00Z", updatedAt: "2026-01-05T10:00:00Z",
    }));

    const createdYear = getManufacturerUsageTrends(history.db, { groupBy: "year", dateBasis: "created", manufacturer: "Acme" });
    assert.deepEqual(createdYear.items.map((row) => row.bucket).sort(), ["2024", "2025"]);
    const createdQuarter = getManufacturerUsageTrends(history.db, { groupBy: "quarter", dateBasis: "created", manufacturer: "Acme" });
    assert.ok(createdQuarter.items.some((row) => row.bucket === "2024-Q1"));
    assert.ok(createdQuarter.items.some((row) => row.bucket === "2024-Q3"));
    assert.ok(createdQuarter.items.some((row) => row.bucket === "2025-Q1"));

    const updatedYear = getManufacturerUsageTrends(history.db, { groupBy: "year", dateBasis: "updated", manufacturer: "Acme" });
    assert.deepEqual(updatedYear.items.map((row) => row.bucket).sort(), ["2025", "2026"]);
    assert.notDeepEqual(
      createdYear.items.map((row) => `${row.bucket}:${row.projectCount}`).sort(),
      updatedYear.items.map((row) => `${row.bucket}:${row.projectCount}`).sort(),
    );

    // Distinct IDs across projects → zero duplicates reported.
    const qualityClean = getJetbuiltHistoryDataQuality(history.db);
    assert.deepEqual(qualityClean.duplicateChildIds, { room: 0, system: 0, lineItem: 0 });

    // Inject deliberate cross-project ID collisions into projections (source-truth edge case reporting).
    const runId = history.db.prepare("SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1").get().id;
    history.db.prepare("INSERT INTO rooms(jetbuilt_id, project_id, name_raw, last_seen_run_id) VALUES ('9101','9002','dup-room',?)").run(runId);
    history.db.prepare("INSERT INTO systems(jetbuilt_id, project_id, name_raw, last_seen_run_id) VALUES ('9201','9002','dup-system',?)").run(runId);
    history.db.prepare("INSERT INTO line_items(jetbuilt_id, project_id, room_id, system_id, manufacturer_raw, model_raw, quantity_raw, quantity_numeric, quantity_state, last_seen_run_id) VALUES ('9001-display','9002','9102','9202','Acme','Display-55','1',1,'valid',?)").run(runId);
    const qualityDup = getJetbuiltHistoryDataQuality(history.db);
    assert.equal(qualityDup.duplicateChildIds.room, 1);
    assert.equal(qualityDup.duplicateChildIds.system, 1);
    assert.equal(qualityDup.duplicateChildIds.lineItem, 1);
  } finally {
    history.close();
  }
});

test("phase 2 classification and dual fingerprints preserve full source and filter non-schematic only", () => {
  const history = tempDb();
  try {
    assert.equal(JETBUILT_SCHEMATIC_RELEVANCE_VERSION, "jetbuilt-schematic-relevance-v1");
    assert.equal(jetbuiltSchematicRelevanceV1RuleCount(), 10);
    assert.equal(listJetbuiltSchematicRelevanceV1Rules().length, 10);

    const installation = classifyJetbuiltHistoryLine("Tateside", "Installation");
    assert.deepEqual({
      classificationVersion: installation.classificationVersion,
      class: installation.class,
      schematicRelevant: installation.schematicRelevant,
      ruleId: installation.ruleId,
    }, {
      classificationVersion: "jetbuilt-schematic-relevance-v1",
      class: "labour-service",
      schematicRelevant: false,
      ruleId: "exact:tateside:installation",
    });
    assert.ok(installation.reason);

    // Formatting-equivalent manufacturer forms normalize together.
    const dashInstallation = classifyJetbuiltHistoryLine("Tateside -", "Installation");
    assert.equal(dashInstallation.ruleId, "exact:tateside:installation");
    assert.equal(dashInstallation.schematicRelevant, false);

    const commissioning = classifyJetbuiltHistoryLine("Tateside", "Commissioning");
    assert.equal(commissioning.class, "labour-service");
    assert.equal(commissioning.schematicRelevant, false);

    const pm = classifyJetbuiltHistoryLine("Tateside", "Project Management");
    assert.equal(pm.class, "project-management");
    assert.equal(pm.schematicRelevant, false);

    const sundries = classifyJetbuiltHistoryLine("Tateside", "Sundries");
    assert.equal(sundries.class, "sundries");
    const generalSundries = classifyJetbuiltHistoryLine("Tateside", "General Fixings & Sundries");
    assert.equal(generalSundries.class, "sundries");
    assert.equal(generalSundries.schematicRelevant, false);

    const programming = classifyJetbuiltHistoryLine("Tateside", "Programming");
    assert.equal(programming.class, "labour-service");
    const engineering = classifyJetbuiltHistoryLine("Tateside", "Engineering Resource");
    assert.equal(engineering.class, "labour-service");
    const shipping = classifyJetbuiltHistoryLine("Tateside", "Shipping");
    assert.equal(shipping.class, "logistics");
    const delivery = classifyJetbuiltHistoryLine("Delivery", "Delivery");
    assert.equal(delivery.class, "logistics");
    const travel = classifyJetbuiltHistoryLine("Tateside", "Travel");
    assert.equal(travel.class, "travel");

    // Note remains unknown and included (insufficient certainty for V1 exclusion).
    const note = classifyJetbuiltHistoryLine("Tateside", "Note");
    assert.deepEqual({ class: note.class, schematicRelevant: note.schematicRelevant, ruleId: note.ruleId, reason: note.reason }, {
      class: "unknown", schematicRelevant: null, ruleId: null, reason: null,
    });

    // Real unmatched manufacturers must stay unknown — coverage gaps, not non-schematic.
    for (const [maker, model] of [
      ["Logitech", "Meetup"], ["Cisco", "Room Kit"], ["Lightware", "CAB-USBC"], ["NUC", "NUC8"],
      ["Sennheiser", "TeamConnect"], ["Yealink", "UVC84"], ["QSC", "Core 110f"], ["AUDAC", "M2"],
      ["Neat", "Bar"], ["Shure", "MXA910"],
    ]) {
      const result = classifyJetbuiltHistoryLine(maker, model);
      assert.equal(result.class, "unknown", `${maker}/${model}`);
      assert.equal(result.schematicRelevant, null, `${maker}/${model}`);
    }

    const run = createSyncRun(history.db, "fixture", {});
    const mixedA = mixedDeviceAndInternalBundle({
      projectId: "A1", clientId: "client-x", stage: "completed", roomId: "RA1", systemId: "SA1", createdAt: "2025-01-01T00:00:00Z",
    });
    const mixedB = mixedDeviceAndInternalBundle({
      projectId: "A2", clientId: "client-x", stage: "install", roomId: "RA2", systemId: "SA2", createdAt: "2025-02-01T00:00:00Z", reverse: true,
    });
    const mixedQty = mixedDeviceAndInternalBundle({
      projectId: "A3", clientId: "client-y", stage: "estimate", roomId: "RA3", systemId: "SA3", createdAt: "2025-03-01T00:00:00Z",
    });
    mixedQty.items[0].quantity = 5;
    const internalOnly1 = internalOnlyBundle({
      projectId: "I1", clientId: "client-i1", stage: "completed", roomId: "RI1", systemId: "SI1", createdAt: "2025-04-01T00:00:00Z",
      manufacturer: "Tateside", model: "Project Management", quantity: 1,
    });
    const internalOnly2 = internalOnlyBundle({
      projectId: "I2", clientId: "client-i2", stage: "contract", roomId: "RI2", systemId: "SI2", createdAt: "2025-05-01T00:00:00Z",
      manufacturer: "Tateside", model: "Project Management", quantity: 1,
    });
    const shippingOnly1 = internalOnlyBundle({
      projectId: "S1", clientId: "client-s1", stage: "proposal", roomId: "RS1", systemId: "SS1", createdAt: "2025-06-01T00:00:00Z",
      manufacturer: "Tateside", model: "Shipping", quantity: 1,
    });
    const shippingOnly2 = internalOnlyBundle({
      projectId: "S2", clientId: "client-s2", stage: "proposal", roomId: "RS2", systemId: "SS2", createdAt: "2025-07-01T00:00:00Z",
      manufacturer: "Tateside", model: "Shipping", quantity: 1,
    });
    for (const bundle of [mixedA, mixedB, mixedQty, internalOnly1, internalOnly2, shippingOnly1, shippingOnly2]) {
      ingestHistoryProject(history.db, run, bundle);
    }
    history.db.prepare("INSERT INTO canonical_template_links(project_id, line_item_id, canonical_template_id, match_method, confidence, matched_at, matcher_version) VALUES (?, ?, 'template-display', 'exact_normalized_manufacturer_model', 'deterministic', ?, 'exact-v1')")
      .run("A1", "A1-display", "2026-07-11T00:00:00Z");
    history.db.prepare("INSERT INTO canonical_template_links(project_id, line_item_id, canonical_template_id, match_method, confidence, matched_at, matcher_version) VALUES (?, ?, 'template-display', 'exact_normalized_manufacturer_model', 'deterministic', ?, 'exact-v1')")
      .run("A2", "A2-display", "2026-07-11T00:00:00Z");

    const fullA = getRoomBomFingerprint(history.db, "A1", "RA1", { fingerprintMode: "full-source" });
    const schematicA = getRoomBomFingerprint(history.db, "A1", "RA1", { fingerprintMode: "schematic-relevant" });
    assert.equal(fullA.fingerprintMode, "full-source");
    assert.equal(schematicA.fingerprintMode, "schematic-relevant");
    assert.equal(schematicA.classificationVersion, "jetbuilt-schematic-relevance-v1");
    assert.equal(fullA.fullSourceFingerprint, schematicA.fullSourceFingerprint);
    assert.notEqual(fullA.fullSourceFingerprint, fullA.schematicRelevantFingerprint);
    assert.equal(fullA.lineItemCount, 3);
    assert.equal(fullA.excludedLineItemCount, 1);
    assert.equal(fullA.schematicRelevantLineItemCount, 2);
    assert.ok(fullA.entries.some((entry) => entry.identity === "raw:tateside::installation"));
    assert.ok(!schematicA.entries.some((entry) => entry.identity === "raw:tateside::installation"));
    // Unknown Logitech remains included in schematic-relevant.
    assert.ok(schematicA.entries.some((entry) => entry.identity === "raw:logitech::meetup"));
    // Canonical preference remains intact.
    assert.ok(schematicA.entries.some((entry) => entry.identity === "canonical:template-display"));
    // Raw fallback for unmatched DSP-like unknown remains when present.
    assert.ok(schematicA.entries.some((entry) => entry.identityKind === "raw" || entry.identityKind === "canonical"));

    // Full-source order independence (reverse item order in A2).
    const fullB = getRoomBomFingerprint(history.db, "A2", "RA2", { fingerprintMode: "full-source" });
    assert.equal(fullA.fullSourceFingerprint, fullB.fullSourceFingerprint);
    assert.equal(fullA.schematicRelevantFingerprint, fullB.schematicRelevantFingerprint);

    // Schematic-relevant order independence.
    const schematicB = getRoomBomFingerprint(history.db, "A2", "RA2", { fingerprintMode: "schematic-relevant" });
    assert.equal(schematicA.fingerprint, schematicB.fingerprint);

    // Quantity sensitivity: full-source and schematic-relevant both change when device qty changes.
    const fullQty = getRoomBomFingerprint(history.db, "A3", "RA3", { fingerprintMode: "full-source" });
    assert.notEqual(fullA.fullSourceFingerprint, fullQty.fullSourceFingerprint);
    assert.notEqual(fullA.schematicRelevantFingerprint, fullQty.schematicRelevantFingerprint);

    // Internal-only rooms remain available in full-source mode.
    const internalFull = getRoomBomFingerprint(history.db, "I1", "RI1", { fingerprintMode: "full-source" });
    assert.equal(internalFull.emptyAfterSchematicFiltering, true);
    assert.ok(internalFull.fullSourceFingerprint);
    assert.equal(internalFull.schematicRelevantFingerprint, null);
    assert.equal(internalFull.entries.length, 1);

    const internalSchematic = getRoomBomFingerprint(history.db, "I1", "RI1", { fingerprintMode: "schematic-relevant" });
    assert.equal(internalSchematic.fingerprint, null);
    assert.equal(internalSchematic.emptyAfterSchematicFiltering, true);

    // Full-source repeated patterns include internal-only exact BOM matches.
    const fullRoomPatterns = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" });
    assert.equal(fullRoomPatterns.fingerprintMode, "full-source");
    assert.ok(fullRoomPatterns.total >= 2);
    const fullSummary = summarizeRepeatedPatterns(history.db, "room", "full-source");
    assert.ok(fullSummary.crossProjectRepeatedPatternCount >= 1);

    // Schematic-relevant must not create misleading empty/internal-only repeated patterns.
    const schematicRoomPatterns = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "schematic-relevant" });
    assert.equal(schematicRoomPatterns.fingerprintMode, "schematic-relevant");
    assert.equal(schematicRoomPatterns.classificationVersion, "jetbuilt-schematic-relevance-v1");
    assert.ok(schematicRoomPatterns.emptyAfterSchematicFiltering >= 4);
    assert.ok(schematicRoomPatterns.patternsSuppressedBecauseOnlyDeterministicallyNonSchematic >= 4);
    // Mixed rooms A1/A2 share schematic-relevant fingerprint (installation excluded, devices match).
    assert.ok(schematicRoomPatterns.total >= 1);
    assert.notEqual(fullRoomPatterns.total, schematicRoomPatterns.total);

    const schematicSummary = summarizeRepeatedPatterns(history.db, "room", "schematic-relevant");
    assert.notEqual(fullSummary.repeatedPatternCount, schematicSummary.repeatedPatternCount);

    // Systems: internal-only shipping patterns exist full-source, suppressed schematic-relevant.
    const fullSystemPatterns = getCommonSystemBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" });
    const schematicSystemPatterns = getCommonSystemBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "schematic-relevant" });
    assert.ok(fullSystemPatterns.total >= 2);
    assert.ok(schematicSystemPatterns.emptyAfterSchematicFiltering >= 4);
    assert.notEqual(fullSystemPatterns.total, schematicSystemPatterns.total);

    // Dual similarity scores remain distinct when full BOM differs only by non-schematic lines is hard;
    // here compare mixed identical schematic rooms — both scores exact.
    const similar = findSimilarRooms(history.db, "A1", "RA1", { fingerprintMode: "schematic-relevant" });
    const match = similar.items.find((item) => item.roomId === "RA2");
    assert.ok(match);
    assert.equal(match.exactSchematicRelevantFingerprintMatch, true);
    assert.equal(match.exactFullSourceFingerprintMatch, true);
    assert.equal(match.fullSourceSimilarityScore, match.schematicRelevantSimilarityScore);
    assert.ok(Object.hasOwn(match.components, "fullBomLineWeightedJaccard"));
    assert.ok(Object.hasOwn(match.components, "schematicRelevantBomLineWeightedJaccard"));
    assert.equal(similar.fingerprintMode, "schematic-relevant");
    assert.ok(String(similar.formula).includes("schematic-relevant"));

    // Full-source ranking mode remains available.
    const similarFull = findSimilarRooms(history.db, "A1", "RA1", { fingerprintMode: "full-source" });
    assert.equal(similarFull.fingerprintMode, "full-source");
    assert.ok(String(similarFull.formula).includes("full BOM-line"));

    // Design default is schematic-relevant.
    const defaultPatterns = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2 });
    assert.equal(defaultPatterns.fingerprintMode, "schematic-relevant");

    const classSummary = getHistoricalLineClassificationSummary(history.db);
    assert.equal(classSummary.classificationVersion, "jetbuilt-schematic-relevance-v1");
    assert.ok(classSummary.deterministicallyNonSchematicLineCount >= 4);
    assert.ok(classSummary.lineCountsByClass["labour-service"] >= 2 || classSummary.lineCountsByClass["project-management"] >= 2);

    // No template/taxonomy mutation path exists through intelligence (history DB only links table).
    const beforeLinks = history.db.prepare("SELECT count(*) count FROM canonical_template_links").get().count;
    getCommonRoomBomPatterns(history.db, { fingerprintMode: "schematic-relevant" });
    findSimilarRooms(history.db, "A1", "RA1");
    assert.equal(history.db.prepare("SELECT count(*) count FROM canonical_template_links").get().count, beforeLinks);

    // Deterministic ordering of pattern fingerprints.
    const again = getCommonRoomBomPatterns(history.db, { minimumOccurrence: 2, fingerprintMode: "full-source" });
    assert.deepEqual(again.items.map((item) => item.fingerprint), fullRoomPatterns.items.map((item) => item.fingerprint));
  } finally {
    history.close();
  }
});

test("phase 3 jetbuilt library discovery ranks real devices without quantity domination", () => {
  const history = tempDb();
  const canonicalDir = mkdtempSync(path.join(tmpdir(), "jetbuilt-discovery-canonical-"));
  const canonical = openDatabase(path.join(canonicalDir, "canonical.db"));
  try {
    runMigrations(canonical);
    saveTemplates(canonical, { templates: [
      { label: "Logitech Rally", manufacturer: "Logitech", modelNumber: "Rally", deviceType: "camera", category: "video", ports: [] },
      { label: "Acme Display", manufacturer: "Acme", modelNumber: "Display-55", deviceType: "display", category: "video", ports: [] },
    ] });

    const run = createSyncRun(history.db, "fixture", {});
    const now = Date.parse("2026-07-01T00:00:00Z");

    // High quantity cable-like identity in one estimate project only — must not dominate.
    ingestHistoryProject(history.db, run, {
      project: { id: "P-cable", client: { id: "c-cable" }, stage: "estimate", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
      rooms: [{ id: "R-cable", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }],
      systems: [{ id: "S-cable", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }],
      items: [{ id: "L-cable", manufacturer_name: "Tateside", model: "CAT6 cable", quantity: 2310, room: { id: "R-cable" }, system: { id: "S-cable" }, created_at: "2024-01-01T00:00:00Z" }],
    });

    // Known non-schematic installation lines across multiple completed projects — excluded by default.
    for (const [projectId, roomId, systemId, clientId] of [
      ["P-inst-1", "R-inst-1", "S-inst-1", "c1"],
      ["P-inst-2", "R-inst-2", "S-inst-2", "c2"],
      ["P-inst-3", "R-inst-3", "S-inst-3", "c3"],
    ]) {
      ingestHistoryProject(history.db, run, internalOnlyBundle({
        projectId, clientId, stage: "completed", roomId, systemId, createdAt: "2025-06-01T00:00:00Z",
        manufacturer: "Tateside -", model: "Installation", quantity: 5,
      }));
    }

    // Real unmatched device across delivered projects and rooms.
    for (const [projectId, roomId, systemId, clientId, stage, createdAt] of [
      ["P-logi-1", "R-logi-1", "S-logi-1", "c-l1", "completed", "2025-11-01T00:00:00Z"],
      ["P-logi-2", "R-logi-2", "S-logi-2", "c-l2", "install", "2025-12-01T00:00:00Z"],
      ["P-logi-3", "R-logi-3a", "S-logi-3", "c-l3", "completed", "2026-01-15T00:00:00Z"],
    ]) {
      ingestHistoryProject(history.db, run, {
        project: { id: projectId, client: { id: clientId }, stage, created_at: createdAt, updated_at: createdAt },
        rooms: [{ id: roomId, created_at: createdAt, updated_at: createdAt }],
        systems: [{ id: systemId, created_at: createdAt, updated_at: createdAt }],
        items: [
          { id: `${projectId}-meetup`, manufacturer_name: "Logitech", model: "Meetup", quantity: 1, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
          { id: `${projectId}-mic`, manufacturer_name: "Logitech", model: "Expansion Mic for Meetup", quantity: 1, room: { id: roomId }, system: { id: systemId }, created_at: createdAt },
        ],
      });
    }
    // Extra room for meetup in third project to raise room count.
    history.db.prepare("INSERT INTO rooms(jetbuilt_id, project_id, name_raw, last_seen_run_id) VALUES ('R-logi-3b','P-logi-3','extra',?)").run(run);
    history.db.prepare("INSERT INTO line_items(jetbuilt_id, project_id, room_id, system_id, manufacturer_raw, model_raw, quantity_raw, quantity_numeric, quantity_state, last_seen_run_id, source_created_at) VALUES ('P-logi-3-meetup-b','P-logi-3','R-logi-3b','S-logi-3','Logitech','Meetup','1',1,'valid',?,'2026-01-15T00:00:00Z')").run(run);

    // Exact-matched Acme display — excluded from default unmatched candidates.
    ingestHistoryProject(history.db, run, intelligenceBundle({
      projectId: "P-matched", clientId: "c-matched", stage: "completed", roomId: "R-matched", systemId: "S-matched",
      displayQuantity: 1, createdAt: "2026-02-01T00:00:00Z",
    }));
    history.db.prepare("INSERT INTO canonical_template_links(project_id, line_item_id, canonical_template_id, match_method, confidence, matched_at, matcher_version) VALUES ('P-matched','P-matched-display','template-display','exact_normalized_manufacturer_model','deterministic','2026-07-11T00:00:00Z','exact-v1')").run();

    // Formatting-equivalent manufacturer forms share candidate key.
    ingestHistoryProject(history.db, run, {
      project: { id: "P-neat", client: { id: "c-neat" }, stage: "completed", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" },
      rooms: [{ id: "R-neat", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" }],
      systems: [{ id: "S-neat", created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" }],
      items: [{ id: "L-neat", manufacturer_name: "Neat", model: "Neat Center SE", quantity: 1, room: { id: "R-neat" }, system: { id: "S-neat" }, created_at: "2026-03-01T00:00:00Z" }],
    });

    const summary = getJetbuiltLibraryCoverageSummary(history.db, {}, now);
    assert.equal(summary.classificationVersion, "jetbuilt-schematic-relevance-v1");
    assert.equal(summary.canonicalMatcherVersion, "exact-v1");
    assert.ok(summary.knownNonSchematicLines >= 3);
    assert.ok(summary.unmatchedLines > summary.eligibleUnmatchedCandidateLines);
    assert.ok(summary.distinctEligibleCandidateIdentities >= 3);

    const ranked = getJetbuiltLibraryCandidates(history.db, { limit: 25 }, now);
    assert.equal(ranked.filtersApplied.excludeKnownNonSchematic, true);
    assert.equal(ranked.filtersApplied.exactCanonicalMatch, false);
    assert.ok(ranked.items.every((item) => item.classification.schematicRelevant !== false));
    assert.ok(ranked.items.every((item) => item.exactCanonicalMatch === false));
    assert.ok(!ranked.items.some((item) => item.candidateKey === "tateside::installation"));
    assert.ok(!ranked.items.some((item) => item.candidateKey === "acme::display55"));

    const meetup = ranked.items.find((item) => item.candidateKey === "logitech::meetup");
    assert.ok(meetup);
    assert.equal(meetup.projectCount, 3);
    assert.equal(meetup.roomCount, 4);
    assert.equal(meetup.completedProjectCount, 2);
    assert.equal(meetup.installProjectCount, 1);
    assert.equal(meetup.deliveredOrInstalledProjectCount, 3);
    assert.ok(meetup.priorityReasons.some((reason) => reason.includes("delivered-or-installed")));
    assert.ok(meetup.priorityScore > 0);

    const cable = getJetbuiltLibraryCandidates(history.db, { excludeKnownNonSchematic: true, exactCanonicalMatch: false, minimumProjectCount: 1 }, now)
      .items.find((item) => item.candidateKey === "tateside::cat6cable");
    assert.ok(cable);
    assert.ok(cable.validQuantityTotal >= 2310);
    assert.ok(meetup.priorityScore > cable.priorityScore);

    // No fuzzy merge: meetup and expansion mic remain distinct.
    assert.ok(ranked.items.some((item) => item.candidateKey === "logitech::expansionmicformeetup"));
    assert.notEqual(meetup.candidateKey, "logitech::expansionmicformeetup");

    // Include known non-schematic when explicitly requested.
    const withInternal = getJetbuiltLibraryCandidates(history.db, { excludeKnownNonSchematic: false, exactCanonicalMatch: false }, now);
    assert.ok(withInternal.items.some((item) => item.candidateKey === "tateside::installation"));

    // Manufacturer filter.
    const logitechOnly = getJetbuiltLibraryCandidates(history.db, { manufacturer: "Logitech" }, now);
    assert.ok(logitechOnly.items.length >= 1);
    assert.ok(logitechOnly.items.every((item) => item.normalizedManufacturer === "logitech"));

    // Cohort filter.
    const completedOnly = getJetbuiltLibraryCandidates(history.db, { cohort: "completed" }, now);
    assert.ok(completedOnly.items.every((item) => item.cohortCounts.completed >= 1 || item.projectCount >= 1));

    // Pagination deterministic.
    const page1 = getJetbuiltLibraryCandidates(history.db, { limit: 1, offset: 0 }, now);
    const page2 = getJetbuiltLibraryCandidates(history.db, { limit: 1, offset: 1 }, now);
    assert.equal(page1.count, 1);
    assert.equal(page1.hasMore, page1.total > 1);
    if (page1.total > 1) assert.notEqual(page1.items[0].candidateKey, page2.items[0].candidateKey);
    const again = getJetbuiltLibraryCandidates(history.db, { limit: 10 }, now);
    assert.deepEqual(
      getJetbuiltLibraryCandidates(history.db, { limit: 10 }, now).items.map((item) => item.candidateKey),
      again.items.map((item) => item.candidateKey),
    );

    // Detail + usage + co-occurrence.
    const detail = getJetbuiltLibraryCandidate(history.db, "logitech::meetup", undefined, { canonicalDb: canonical, nowMs: now });
    assert.equal(detail.candidate.candidateKey, "logitech::meetup");
    assert.ok(detail.canonicalCorrelation.manufacturerPresentInLibrary);
    assert.ok(Array.isArray(detail.canonicalCorrelation.possibleRelatedTemplates));
    assert.ok(detail.canonicalCorrelation.possibleRelatedTemplates.every((row) => row.authority === "candidate-review-evidence-only"));
    assert.equal(detail.canonicalCorrelation.exactCanonicalTemplates.length, 0);

    const usage = getJetbuiltCandidateUsage(history.db, "Logitech", "Meetup");
    assert.equal(usage.lineItemOccurrences, 4);
    assert.equal(usage.projectCount, 3);
    assert.equal(usage.roomCount, 4);
    assert.ok(usage.byStage.some((row) => row.stage === "completed"));
    assert.ok(usage.cohortProjectCounts["delivered-or-installed"] >= 3);

    const co = getJetbuiltCandidateCooccurrence(history.db, { candidateKey: "logitech::meetup", minimumRoomCount: 1 });
    const mic = co.items.find((item) => item.candidateKey === "logitech::expansionmicformeetup");
    assert.ok(mic);
    assert.equal(mic.roomCount, 3);
    assert.equal(mic.projectCount, 3);
    assert.ok(mic.lineItemOccurrences >= 3);

    // Ranking function: quantity not used.
    const highQtyLowProjects = scoreJetbuiltDiscoveryCandidate({
      deliveredOrInstalledProjectCount: 0, completedProjectCount: 0, installProjectCount: 0,
      projectCount: 1, roomCount: 1, lastSeen: "2024-01-01T00:00:00Z", hasManufacturerAndModel: true,
    }, now);
    const multiDelivered = scoreJetbuiltDiscoveryCandidate({
      deliveredOrInstalledProjectCount: 3, completedProjectCount: 2, installProjectCount: 1,
      projectCount: 3, roomCount: 4, lastSeen: "2026-01-15T00:00:00Z", hasManufacturerAndModel: true,
    }, now);
    assert.ok(multiDelivered.priorityScore > highQtyLowProjects.priorityScore);

    // No mutations.
    const beforeLinks = history.db.prepare("SELECT count(*) count FROM canonical_template_links").get().count;
    const beforeDevices = canonical.prepare("SELECT count(*) count FROM devices").get().count;
    const beforeTaxonomy = canonical.prepare("SELECT count(*) count FROM taxonomy_registry_values").get().count;
    getJetbuiltLibraryCandidates(history.db, {}, now);
    getJetbuiltLibraryCandidate(history.db, "logitech::meetup", undefined, { canonicalDb: canonical, nowMs: now });
    assert.equal(history.db.prepare("SELECT count(*) count FROM canonical_template_links").get().count, beforeLinks);
    assert.equal(canonical.prepare("SELECT count(*) count FROM devices").get().count, beforeDevices);
    assert.equal(canonical.prepare("SELECT count(*) count FROM taxonomy_registry_values").get().count, beforeTaxonomy);

    // Thin MCP adapter remains read-only for discovery.
    const tools = createMcpLibraryTools({
      db: canonical,
      config: { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true },
      historyDb: history.db,
    });
    const mcpCandidates = tools.execute("get_jetbuilt_library_candidates", { limit: 5 });
    assert.equal(mcpCandidates.success, true);
    assert.equal(mcpCandidates.readOnly, true);
    assert.ok(mcpCandidates.items.some((item) => item.candidateKey === "logitech::meetup"));
    const mcpDetail = tools.execute("get_jetbuilt_library_candidate", { candidateKey: "logitech::meetup" });
    assert.equal(mcpDetail.success, true);
    assert.equal(mcpDetail.readOnly, true);
    assert.throws(() => createMcpLibraryTools({
      db: canonical,
      config: { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true },
    }).execute("get_jetbuilt_library_candidates", {}), /history database is not configured/);
  } finally {
    canonical.close();
    rmSync(canonicalDir, { recursive: true, force: true });
    history.close();
  }
});

test("phase 5 project gap lookup assembles one full BOM and classifies exact identities deterministically", async () => {
  const history = tempDb();
  const canonicalRoot = mkdtempSync(path.join(tmpdir(), "jetbuilt-project-gap-"));
  const canonical = openDatabase(path.join(canonicalRoot, "canonical.db"));
  try {
    runMigrations(canonical);
    saveTemplates(canonical, { templates: [
      { label: "Display D-1", manufacturer: "Acme", modelNumber: "D-1", category: "Displays", deviceType: "display", ports: [] },
      { label: "Gamma Base", manufacturer: "Gamma", modelNumber: "BASE", category: "Sources", deviceType: "camera", searchTerms: ["SKU-UK"], ports: [] },
    ] });
    const proposal = createLibraryDoctorNewTemplateProposal(canonical, {
      proposedTemplate: { manufacturer: "Neat", modelNumber: "Neat Center", label: "Neat Center", category: "Sources", deviceType: "camera", ports: [] },
      identityAliases: ["Neat Center SE"],
      evidenceRefs: [{ type: "official-product-page", url: "https://neat.no/center/" }],
      classificationConfidence: "high",
      qualityGates: { identityVerifiedByCaller: true, officialEvidenceDeclaredByCaller: true, physicalPortsDeclaration: "not-applicable", dimensionsDeclaration: "unavailable", noValidDataOmittedConfirmedByCaller: true },
      generationKey: "jetbuilt:neat::neatcenterse:new-template:v1",
    });
    assert.equal(proposal.success, true);

    const run = createSyncRun(history.db, "fixture", {});
    ingestHistoryProject(history.db, run, {
      project: { id: "jb-12345", custom_id: "P-12345", name: "Redacted fixture project", stage: "completed", active: true },
      rooms: [{ id: "R1", name: "Room 1" }, { id: "R2", name: "Room 2" }],
      systems: [{ id: "S1", name: "System 1" }, { id: "S2", name: "System 2" }],
      items: [
        { id: "L1", manufacturer_name: "Acme", model: "D-1", quantity: 1, room: { id: "R1" }, system: { id: "S1" } },
        { id: "L2", manufacturer_name: "Tateside", model: "Installation", quantity: 1, room: { id: "R1" }, system: { id: "S1" } },
        { id: "L3", manufacturer_name: "Neat", model: "Neat Center SE", quantity: 1, room: { id: "R1" }, system: { id: "S1" } },
        { id: "L4", manufacturer_name: "Beta", model: "CAM-X", quantity: 2, room: { id: "R1" }, system: { id: "S1" } },
        { id: "L5", manufacturer_name: " beta ", model: "CAM X", quantity: 1, room: { id: "R2" }, system: { id: "S2" } },
        { id: "L6", manufacturer_name: "Gamma", model: "SKU-UK", quantity: 1, room: { id: "R2" }, system: { id: "S2" } },
        { id: "L7", manufacturer_name: "Incomplete", quantity: 1, room: { id: "R2" }, system: { id: "S2" } },
      ],
    });
    const canonicalBefore = JSON.stringify({
      devices: canonical.prepare("SELECT * FROM devices ORDER BY id").all(),
      versions: canonical.prepare("SELECT * FROM device_versions ORDER BY id").all(),
      proposals: canonical.prepare("SELECT * FROM library_doctor_proposals ORDER BY id").all(),
    });
    const historyBefore = JSON.stringify({
      projects: history.db.prepare("SELECT * FROM projects ORDER BY jetbuilt_id").all(),
      lines: history.db.prepare("SELECT * FROM line_items ORDER BY project_id, jetbuilt_id").all(),
      runs: history.db.prepare("SELECT * FROM sync_runs ORDER BY id").all(),
    });

    const analysis = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "p12345");
    assert.equal(analysis.matchedProjectId, "jb-12345");
    assert.equal(analysis.lineItemCount, 7);
    assert.equal(analysis.distinctCandidateIdentityCount, 5);
    assert.equal(analysis.rooms.length, 2);
    assert.equal(analysis.systems.length, 2);
    assert.equal(analysis.summary.exactCanonicalMatches, 1);
    assert.equal(analysis.summary.knownNonSchematic, 1);
    assert.equal(analysis.summary.alreadyProposed, 1);
    assert.equal(analysis.summary.possibleIdentityVariants, 1);
    assert.equal(analysis.summary.unmatchedEligible, 1);
    assert.equal(analysis.insufficientIdentityLines.length, 1);
    const beta = analysis.candidates.find((candidate) => candidate.candidateKey === "beta::camx");
    assert.equal(beta.status, "unmatched-hardware-candidate");
    assert.equal(beta.projectUsage.lineItemCount, 2);
    assert.equal(beta.projectUsage.validQuantityTotal, 3);
    assert.equal(beta.projectUsage.rooms.length, 2);
    const neat = analysis.candidates.find((candidate) => candidate.candidateKey === "neat::neatcenterse");
    assert.equal(neat.status, "already-proposed");
    assert.equal(neat.existingProposals[0].id, proposal.proposal.id);
    assert.equal(analysis.versions.schematicRelevance, "jetbuilt-schematic-relevance-v1");
    assert.equal(analysis.queryCounts.historyDatabase, 5);
    assert.equal(getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345").runKey, analysis.runKey);
    const tools = createMcpLibraryTools({ db: canonical, historyDb: history.db, config: { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true } });
    const viaMcp = await tools.executeAsync("get_jetbuilt_project_library_gap_analysis", { projectNumber: "P-12345", allowOnDemandAcquisition: false });
    assert.equal(viaMcp.runKey, analysis.runKey);
    assert.equal(viaMcp.queryCounts.canonicalDatabase, 3);
    const server = createTateSideMcpServer({ db: canonical, historyDb: history.db, config: { mcpLibraryEnabled: true, dynamicTaxonomyEnabled: true, libraryAuditEnabled: true, libraryDoctorEnabled: true } });
    const client = new Client({ name: "project-gap-output-schema-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const viaClient = await client.callTool({ name: "get_jetbuilt_project_library_gap_analysis", arguments: { projectNumber: "P-12345", allowOnDemandAcquisition: false } });
      assert.notEqual(viaClient.isError, true, viaClient.content[0]?.text);
      assert.equal(viaClient.structuredContent.runKey, analysis.runKey);
    } finally {
      await client.close();
      await server.close();
    }
    assert.equal(JSON.stringify({ devices: canonical.prepare("SELECT * FROM devices ORDER BY id").all(), versions: canonical.prepare("SELECT * FROM device_versions ORDER BY id").all(), proposals: canonical.prepare("SELECT * FROM library_doctor_proposals ORDER BY id").all() }), canonicalBefore);
    assert.equal(JSON.stringify({ projects: history.db.prepare("SELECT * FROM projects ORDER BY jetbuilt_id").all(), lines: history.db.prepare("SELECT * FROM line_items ORDER BY project_id, jetbuilt_id").all(), runs: history.db.prepare("SELECT * FROM sync_runs ORDER BY id").all() }), historyBefore);

    assert.match(analysis.projectSourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(analysis.proposalStateSemantics, "live-overlay-excluded-from-run-key");
    canonical.prepare(`INSERT INTO jetbuilt_project_gap_candidate_results
      (run_key, candidate_key, project_number, analysis_version, canonical_snapshot_identity, status, attempted_payload_json, validation_issues_json, proposal_id, updated_at)
      VALUES (?, ?, ?, ?, ?, 'validation-failed', '{}', '["fixture failure"]', NULL, '2026-01-01T00:00:00.000Z')`).run(
      analysis.runKey, "beta::camx", analysis.projectNumber, analysis.analysisVersion, analysis.canonicalSnapshotIdentity,
    );
    assert.equal(getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345").candidates.find((candidate) => candidate.candidateKey === "beta::camx").status, "needs-manual-review");

    history.db.prepare("UPDATE line_items SET quantity_raw='3', quantity_numeric=3 WHERE project_id='jb-12345' AND jetbuilt_id='L4'").run();
    const quantityChanged = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.notEqual(quantityChanged.runKey, analysis.runKey);
    assert.notEqual(quantityChanged.projectSourceFingerprint, analysis.projectSourceFingerprint);
    assert.equal(quantityChanged.candidates.find((candidate) => candidate.candidateKey === "beta::camx").status, "unmatched-hardware-candidate");
    assert.equal(quantityChanged.candidates.find((candidate) => candidate.candidateKey === "beta::camx").previousResult, null);
    history.db.prepare("UPDATE line_items SET quantity_raw='2', quantity_numeric=2 WHERE project_id='jb-12345' AND jetbuilt_id='L4'").run();
    assert.equal(getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345").runKey, analysis.runKey);

    history.db.prepare(`INSERT INTO line_items
      (jetbuilt_id, project_id, manufacturer_raw, model_raw, quantity_raw, quantity_numeric, quantity_state, replacement_ids_json, last_seen_run_id)
      VALUES ('L8', 'jb-12345', 'Delta', 'NEW-1', '1', 1, 'valid', '[]', ?)` ).run(run);
    const lineAdded = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.notEqual(lineAdded.runKey, analysis.runKey);
    history.db.prepare("DELETE FROM line_items WHERE project_id='jb-12345' AND jetbuilt_id='L8'").run();
    const lineRemoved = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.notEqual(lineRemoved.runKey, lineAdded.runKey);
    assert.equal(lineRemoved.runKey, analysis.runKey);

    history.db.prepare("UPDATE line_items SET room_id='R2', system_id='S2' WHERE project_id='jb-12345' AND jetbuilt_id='L4'").run();
    const relationshipChanged = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.notEqual(relationshipChanged.runKey, analysis.runKey);
    history.db.prepare("UPDATE line_items SET room_id='R1', system_id='S1' WHERE project_id='jb-12345' AND jetbuilt_id='L4'").run();
    assert.equal(getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345").runKey, analysis.runKey);

    saveTemplates(canonical, { templates: [{ label: "Canonical Snapshot Fixture", manufacturer: "Snapshot", modelNumber: "ONLY-1", category: "Sources", deviceType: "camera", ports: [] }] });
    const canonicalChanged = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.equal(canonicalChanged.projectSourceFingerprint, analysis.projectSourceFingerprint);
    assert.notEqual(canonicalChanged.canonicalSnapshotIdentity, analysis.canonicalSnapshotIdentity);
    assert.notEqual(canonicalChanged.runKey, analysis.runKey);

    const beforeProposalOverlay = canonicalChanged;
    const betaProposal = createLibraryDoctorNewTemplateProposal(canonical, {
      proposedTemplate: { manufacturer: "Beta", modelNumber: "CAM-X", label: "CAM-X", category: "Sources", deviceType: "camera", ports: [] },
      evidenceRefs: [{ type: "official-page-declared-by-caller", url: "https://manufacturer.example/cam-x" }],
      classificationConfidence: "high",
      qualityGates: { identityVerifiedByCaller: true, officialEvidenceDeclaredByCaller: true, physicalPortsDeclaration: "not-applicable", dimensionsDeclaration: "unavailable", noValidDataOmittedConfirmedByCaller: true },
      generationKey: "jetbuilt:beta::camx:new-template:v1",
    });
    assert.equal(betaProposal.success, true);
    const afterProposalOverlay = getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345");
    assert.equal(afterProposalOverlay.runKey, beforeProposalOverlay.runKey);
    assert.equal(afterProposalOverlay.projectSourceFingerprint, beforeProposalOverlay.projectSourceFingerprint);
    assert.equal(afterProposalOverlay.canonicalSnapshotIdentity, beforeProposalOverlay.canonicalSnapshotIdentity);
    assert.notEqual(afterProposalOverlay.proposalStateIdentity, beforeProposalOverlay.proposalStateIdentity);
    assert.equal(afterProposalOverlay.candidates.find((candidate) => candidate.candidateKey === "beta::camx").status, "already-proposed");

    assert.throws(() => getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-99999"), (error) => error instanceof JetbuiltProjectGapError && error.code === "project-not-found");

    ingestHistoryProject(history.db, run, { project: { id: "jb-duplicate", custom_id: "P 12345", stage: "estimate" }, rooms: [], systems: [], items: [] });
    assert.throws(() => getJetbuiltProjectLibraryGapAnalysis(history.db, canonical, "P-12345"), (error) => error instanceof JetbuiltProjectGapError && error.code === "ambiguous-project");
  } finally {
    canonical.close();
    history.close();
    rmSync(canonicalRoot, { recursive: true, force: true });
  }
});

test("phase 5 exact-project acquisition is GET-only, bounded, idempotent, and resumable after interruption", async () => {
  const history = tempDb();
  const canonicalRoot = mkdtempSync(path.join(tmpdir(), "jetbuilt-project-acquire-"));
  const canonical = openDatabase(path.join(canonicalRoot, "canonical.db"));
  const indexPath = path.join(canonicalRoot, "jetbuilt-index.json");
  writeFileSync(indexPath, JSON.stringify({ projects: [{ id: "9001", customId: "P-54321" }, { id: "9002", customId: "P-FAIL" }] }));
  try {
    runMigrations(canonical);
    const requests = [];
    const makeFetch = (failSystems = false) => async (input, init) => {
      assert.equal(init?.method, "GET");
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (failSystems && url.pathname === "/api/projects/9002/systems") return response("temporary failure", 500);
      const match = url.pathname.match(/^\/api\/projects\/(9001|9002)(?:\/(rooms|systems|items|versions))?$/);
      if (!match) return response({ error: "not found" }, 404);
      const [projectId, resource] = [match[1], match[2]];
      if (!resource) return response({ id: projectId, custom_id: projectId === "9001" ? "P-54321" : "P-FAIL", name: "Redacted", stage: "estimate" });
      if (resource === "rooms") return response({ rooms: [{ id: `R-${projectId}`, name: "Room" }] });
      if (resource === "systems") return response({ systems: [{ id: `S-${projectId}`, name: "System" }] });
      if (resource === "items") return response({ items: [{ id: `L-${projectId}`, manufacturer_name: "Beta", model: `CAM-${projectId}`, quantity: 1, room: { id: `R-${projectId}` }, system: { id: `S-${projectId}` } }] });
      return response({ versions: [] });
    };
    const acquisition = { apiKey: "test-key", baseUrl: "https://jetbuilt.test/api", indexPath, fetchImpl: makeFetch(), sleepImpl: async () => {} };
    await assert.rejects(
      getJetbuiltProjectLibraryGapAnalysisWithAcquisition(history.db, canonical, "P-NOT-CACHED", undefined, acquisition),
      (error) => error instanceof JetbuiltProjectGapError
        && error.code === "project-not-found-in-cached-index"
        && /absence from Jetbuilt is not established/.test(error.message),
    );
    assert.equal(requests.length, 0);
    const first = await getJetbuiltProjectLibraryGapAnalysisWithAcquisition(history.db, canonical, "P-54321", undefined, acquisition);
    assert.equal(first.acquisition.performed, true);
    assert.equal(first.acquisition.jetbuiltGetRequests, 5);
    assert.equal(first.queryCounts.jetbuiltWriteRequests, 0);
    assert.equal(requests.length, 5);
    const second = await getJetbuiltProjectLibraryGapAnalysisWithAcquisition(history.db, canonical, "P-54321", undefined, acquisition);
    assert.equal(second.runKey, first.runKey);
    assert.equal(second.queryCounts.jetbuiltGetRequests, 0);
    assert.equal(requests.length, 5);

    await assert.rejects(
      getJetbuiltProjectLibraryGapAnalysisWithAcquisition(history.db, canonical, "P-FAIL", undefined, { ...acquisition, fetchImpl: makeFetch(true) }),
      /Jetbuilt collection fetch failed/,
    );
    assert.equal(history.db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get().status, "failed");
    const resumed = await getJetbuiltProjectLibraryGapAnalysisWithAcquisition(history.db, canonical, "P-FAIL", undefined, { ...acquisition, fetchImpl: makeFetch(false) });
    assert.equal(resumed.projectNumber, "P-FAIL");
    assert.equal(resumed.candidates.length, 1);
    assert.equal(history.db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get().status, "completed");
  } finally {
    canonical.close();
    history.close();
    rmSync(canonicalRoot, { recursive: true, force: true });
  }
});
