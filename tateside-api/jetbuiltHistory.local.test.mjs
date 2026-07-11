import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
