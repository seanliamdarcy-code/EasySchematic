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
import { syncJetbuiltHistory, validateHistoryBounds } from "../dist-tateside-api/tateside-api/src/jetbuiltHistorySync.js";

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
