import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import { listCurrentTemplates } from "./deviceStore.js";
import { getHistoryRoomDeviceCooccurrence, type DeviceCooccurrenceInput } from "./jetbuiltHistoryIntelligence.js";
import { normalizedLookupKey } from "./quoteImport.js";

const SOURCE_MIGRATIONS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "jetbuilt-history-migrations");
const REPO_MIGRATIONS = path.resolve(process.cwd(), "tateside-api", "jetbuilt-history-migrations");
export const DEFAULT_JETBUILT_HISTORY_DB_PATH = path.resolve(".tateside-data", "jetbuilt-history.db");
export const JETBUILT_HISTORY_MATCHER_VERSION = "exact-v1";

type RecordValue = Record<string, unknown>;

export interface HistoryProjectBundle {
  project: RecordValue;
  rooms: RecordValue[];
  systems: RecordValue[];
  items: RecordValue[];
  versions?: RecordValue[];
}

function migrationsDir(): string {
  return existsSync(SOURCE_MIGRATIONS) ? SOURCE_MIGRATIONS : REPO_MIGRATIONS;
}

export function openJetbuiltHistoryDatabase(dbPath = process.env.TATESIDE_JETBUILT_HISTORY_DB_PATH || DEFAULT_JETBUILT_HISTORY_DB_PATH): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export function runJetbuiltHistoryMigrations(db: DatabaseSync): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map(({ id }) => id));
  const added: string[] = [];
  for (const file of readdirSync(migrationsDir()).filter((name) => name.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(path.join(migrationsDir(), file), "utf8"));
      db.prepare("INSERT INTO schema_migrations(id) VALUES (?)").run(file);
      db.exec("COMMIT");
      added.push(file);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return added;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!child || Array.isArray(child) || typeof child !== "object") return child;
    return Object.fromEntries(Object.entries(child as RecordValue).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return text((value as RecordValue).id);
  return text(value);
}

function bool(value: unknown): number | null {
  if (value === true || value === "true" || value === 1) return 1;
  if (value === false || value === "false" || value === 0) return 0;
  return null;
}

function first(record: RecordValue, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] != null) return record[key];
  return null;
}

function allowlisted(resourceType: string, value: RecordValue): RecordValue {
  const keys: Record<string, string[]> = {
    client: ["id", "company_name", "updated_at"],
    project: ["id", "project_id", "custom_id", "name", "stage", "active", "version", "original_version_id", "created_at", "updated_at", "client"],
    room: ["id", "name", "room_name", "quantity", "multiplier", "active", "created_at", "updated_at"],
    system: ["id", "name", "system_name", "created_at", "updated_at"],
    line_item: ["id", "line_item_id", "product_id", "manufacturer_name", "manufacturer", "model", "part_number", "short_description", "description", "quantity", "kind", "type", "hidden", "option_id", "replacement_ids", "replaces_line_item_ids", "created_at", "updated_at", "room", "system", "labour"],
    version: ["id", "name", "description", "locked", "created_at", "updated_at"],
  };
  return Object.fromEntries((keys[resourceType] ?? Object.keys(value)).filter((key) => key in value).map((key) => [key, value[key]]));
}

export function storeRawSnapshot(
  db: DatabaseSync,
  syncRunId: number,
  resourceType: string,
  sourceId: string,
  payload: RecordValue,
  parentType?: string,
  parentId?: string,
): string {
  const safePayload = allowlisted(resourceType, payload);
  const payloadJson = stableJson(safePayload);
  const hash = createHash("sha256").update(payloadJson).digest("hex");
  db.prepare(`INSERT OR IGNORE INTO raw_snapshots
    (sync_run_id, resource_type, source_id, parent_type, parent_id, source_updated_at, payload_json, payload_sha256, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      syncRunId, resourceType, sourceId, parentType ?? null, parentId ?? null,
      text(first(payload, "updated_at", "updatedAt")), payloadJson, hash, new Date().toISOString(),
    );
  return hash;
}

export function createSyncRun(db: DatabaseSync, mode: string, bounds: unknown): number {
  return Number(db.prepare("INSERT INTO sync_runs(started_at, mode, bounds_json, status) VALUES (?, ?, ?, 'running')")
    .run(new Date().toISOString(), mode, stableJson(bounds)).lastInsertRowid);
}

export function incrementSyncRequestCount(db: DatabaseSync, syncRunId: number): void {
  db.prepare("UPDATE sync_runs SET request_count = request_count + 1 WHERE id = ?").run(syncRunId);
}

export function completeSyncRun(db: DatabaseSync, syncRunId: number, highWaterMark?: string | null): void {
  db.prepare("UPDATE sync_runs SET status = 'completed', completed_at = ?, high_water_mark = ? WHERE id = ?")
    .run(new Date().toISOString(), highWaterMark ?? null, syncRunId);
}

export function failSyncRun(db: DatabaseSync, syncRunId: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare("UPDATE sync_runs SET status = 'failed', completed_at = ?, error_summary = ? WHERE id = ?")
    .run(new Date().toISOString(), message.slice(0, 1000), syncRunId);
}

function quantity(value: unknown): { raw: string | null; numeric: number | null; state: string } {
  const raw = value == null ? null : String(value);
  if (raw == null || raw.trim() === "") return { raw, numeric: null, state: "missing" };
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return { raw, numeric: null, state: "malformed" };
  if (numeric === 0) return { raw, numeric, state: "zero" };
  if (numeric < 0) return { raw, numeric, state: "negative" };
  return { raw, numeric, state: "valid" };
}

function embeddedClient(project: RecordValue): RecordValue | null {
  const value = project.client;
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

export function ingestHistoryProject(db: DatabaseSync, syncRunId: number, bundle: HistoryProjectBundle): void {
  const projectId = idOf(first(bundle.project, "id", "project_id"));
  if (!projectId) throw new Error("Jetbuilt project is missing an ID");
  db.exec("BEGIN");
  try {
    const client = embeddedClient(bundle.project);
    const clientId = idOf(client);
    if (clientId && client) {
      storeRawSnapshot(db, syncRunId, "client", clientId, client);
      db.prepare(`INSERT INTO clients(jetbuilt_id, company_name_raw, source_updated_at, last_seen_run_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(jetbuilt_id) DO UPDATE SET company_name_raw=excluded.company_name_raw, source_updated_at=excluded.source_updated_at, last_seen_run_id=excluded.last_seen_run_id`)
        .run(clientId, text(client.company_name), text(first(client, "updated_at", "updatedAt")), syncRunId);
    }
    storeRawSnapshot(db, syncRunId, "project", projectId, bundle.project);
    db.prepare(`INSERT INTO projects(jetbuilt_id, client_id, custom_id_raw, name_raw, stage_raw, active, version_raw, original_version_id, created_at, updated_at, last_seen_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(jetbuilt_id) DO UPDATE SET client_id=excluded.client_id, custom_id_raw=excluded.custom_id_raw, name_raw=excluded.name_raw,
      stage_raw=excluded.stage_raw, active=excluded.active, version_raw=excluded.version_raw, original_version_id=excluded.original_version_id,
      created_at=excluded.created_at, updated_at=excluded.updated_at, last_seen_run_id=excluded.last_seen_run_id`).run(
        projectId, clientId, text(first(bundle.project, "custom_id", "customId")), text(first(bundle.project, "name", "title")),
        text(bundle.project.stage), bool(bundle.project.active), text(bundle.project.version), idOf(bundle.project.original_version_id),
        text(first(bundle.project, "created_at", "createdAt")), text(first(bundle.project, "updated_at", "updatedAt")), syncRunId,
      );

    for (const room of bundle.rooms) {
      const roomId = idOf(room);
      if (!roomId) throw new Error(`Project ${projectId} has a room without an ID`);
      storeRawSnapshot(db, syncRunId, "room", roomId, room, "project", projectId);
      db.prepare(`INSERT INTO rooms(jetbuilt_id, project_id, name_raw, quantity_raw, active, created_at, updated_at, last_seen_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, jetbuilt_id) DO UPDATE SET name_raw=excluded.name_raw, quantity_raw=excluded.quantity_raw, active=excluded.active,
        created_at=excluded.created_at, updated_at=excluded.updated_at, last_seen_run_id=excluded.last_seen_run_id`).run(
          roomId, projectId, text(first(room, "name", "room_name")), text(first(room, "quantity", "multiplier")), bool(room.active),
          text(room.created_at), text(room.updated_at), syncRunId,
        );
    }
    for (const system of bundle.systems) {
      const systemId = idOf(system);
      if (!systemId) throw new Error(`Project ${projectId} has a system without an ID`);
      storeRawSnapshot(db, syncRunId, "system", systemId, system, "project", projectId);
      db.prepare(`INSERT INTO systems(jetbuilt_id, project_id, name_raw, created_at, updated_at, last_seen_run_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, jetbuilt_id) DO UPDATE SET name_raw=excluded.name_raw, created_at=excluded.created_at,
        updated_at=excluded.updated_at, last_seen_run_id=excluded.last_seen_run_id`).run(
          systemId, projectId, text(first(system, "name", "system_name")), text(system.created_at), text(system.updated_at), syncRunId,
        );
    }
    for (const item of bundle.items) {
      const itemId = idOf(first(item, "id", "line_item_id"));
      if (!itemId) throw new Error(`Project ${projectId} has a line item without an ID`);
      const roomId = idOf(item.room) ?? idOf(item.room_id);
      const systemId = idOf(item.system) ?? idOf(item.system_id);
      const parsedQuantity = quantity(item.quantity);
      const hash = storeRawSnapshot(db, syncRunId, "line_item", itemId, item, "project", projectId);
      db.prepare(`INSERT INTO line_items(jetbuilt_id, project_id, room_id, system_id, product_id, manufacturer_raw, model_raw, part_number_raw,
        description_raw, quantity_raw, quantity_numeric, quantity_state, kind_raw, hidden, option_id, replacement_ids_json,
        source_created_at, source_updated_at, last_seen_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, jetbuilt_id) DO UPDATE SET room_id=excluded.room_id, system_id=excluded.system_id, product_id=excluded.product_id,
        manufacturer_raw=excluded.manufacturer_raw, model_raw=excluded.model_raw, part_number_raw=excluded.part_number_raw,
        description_raw=excluded.description_raw, quantity_raw=excluded.quantity_raw, quantity_numeric=excluded.quantity_numeric,
        quantity_state=excluded.quantity_state, kind_raw=excluded.kind_raw, hidden=excluded.hidden, option_id=excluded.option_id,
        replacement_ids_json=excluded.replacement_ids_json, source_created_at=excluded.source_created_at,
        source_updated_at=excluded.source_updated_at, last_seen_run_id=excluded.last_seen_run_id`).run(
          itemId, projectId, roomId, systemId, idOf(item.product_id), text(first(item, "manufacturer_name", "manufacturer")), text(item.model),
          text(item.part_number), text(first(item, "short_description", "description")), parsedQuantity.raw, parsedQuantity.numeric,
          parsedQuantity.state, text(first(item, "kind", "type")), bool(item.hidden), idOf(item.option_id),
          stableJson(first(item, "replacement_ids", "replaces_line_item_ids") ?? []), text(item.created_at), text(item.updated_at), syncRunId,
        );
      db.prepare("INSERT OR REPLACE INTO line_item_presence(sync_run_id, project_id, line_item_id, payload_sha256) VALUES (?, ?, ?, ?)")
        .run(syncRunId, projectId, itemId, hash);
    }
    for (const version of bundle.versions ?? []) {
      const versionId = idOf(version);
      if (versionId) storeRawSnapshot(db, syncRunId, "version", versionId, version, "project", projectId);
    }
    db.prepare("INSERT INTO project_checkpoints(sync_run_id, project_id, completed_at) VALUES (?, ?, ?)")
      .run(syncRunId, projectId, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function matchHistoryTemplates(db: DatabaseSync, canonicalDb: DatabaseSync): number {
  const byKey = new Map<string, DeviceTemplate[]>();
  for (const template of listCurrentTemplates(canonicalDb)) {
    const key = normalizedLookupKey(template.manufacturer, template.modelNumber || template.label);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), template]);
  }
  const rows = db.prepare("SELECT project_id, jetbuilt_id, manufacturer_raw, model_raw FROM line_items ORDER BY project_id, jetbuilt_id")
    .all() as { project_id: string; jetbuilt_id: string; manufacturer_raw: string | null; model_raw: string | null }[];
  let matched = 0;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM canonical_template_links");
    const insert = db.prepare(`INSERT INTO canonical_template_links(project_id, line_item_id, canonical_template_id, match_method, confidence, matched_at, matcher_version)
      VALUES (?, ?, ?, 'exact_normalized_manufacturer_model', 'deterministic', ?, ?)`);
    for (const row of rows) {
      const candidates = byKey.get(normalizedLookupKey(row.manufacturer_raw, row.model_raw)) ?? [];
      if (candidates.length !== 1) continue;
      insert.run(row.project_id, row.jetbuilt_id, candidates[0].id as string, new Date().toISOString(), JETBUILT_HISTORY_MATCHER_VERSION);
      matched += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return matched;
}

export function getHistoryCoverage(db: DatabaseSync): Record<string, unknown> {
  return { ...db.prepare(`SELECT
    (SELECT count(*) FROM projects) projectCount, (SELECT count(*) FROM clients) clientCount,
    (SELECT count(*) FROM rooms) roomCount, (SELECT count(*) FROM systems) systemCount,
    (SELECT count(*) FROM line_items) lineItemCount,
    (SELECT count(DISTINCT lower(manufacturer_raw)) FROM line_items WHERE manufacturer_raw IS NOT NULL) distinctManufacturers,
    (SELECT count(DISTINCT lower(model_raw)) FROM line_items WHERE model_raw IS NOT NULL) distinctModels,
    (SELECT min(created_at) FROM projects) earliestProjectCreatedAt, (SELECT max(created_at) FROM projects) latestProjectCreatedAt,
    (SELECT min(updated_at) FROM projects) earliestProjectUpdatedAt, (SELECT max(updated_at) FROM projects) latestProjectUpdatedAt,
    (SELECT count(*) FROM canonical_template_links) canonicalMatchCount,
    (SELECT count(*) FROM line_items l LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id WHERE c.line_item_id IS NULL) unmatchedCount,
    (SELECT count(*) FROM line_items WHERE quantity_state != 'valid') invalidOrNonPositiveQuantityCount`).get() as Record<string, unknown> };
}

export interface HistoryProjectSearch {
  projectNumber?: string;
  projectName?: string;
  client?: string;
  stage?: string;
  from?: string;
  to?: string;
  manufacturer?: string;
  model?: string;
  limit?: number;
  offset?: number;
}

export function searchHistoryProjects(db: DatabaseSync, input: HistoryProjectSearch = {}): Record<string, unknown> {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const like = (column: string, value: string | undefined): void => {
    if (!value) return;
    conditions.push(`lower(${column}) LIKE lower(?)`);
    values.push(`%${value}%`);
  };
  like("p.custom_id_raw", input.projectNumber);
  like("p.name_raw", input.projectName);
  like("c.company_name_raw", input.client);
  if (input.stage) { conditions.push("lower(p.stage_raw) = lower(?)"); values.push(input.stage); }
  if (input.from) { conditions.push("p.created_at >= ?"); values.push(input.from); }
  if (input.to) { conditions.push("p.created_at <= ?"); values.push(input.to); }
  if (input.manufacturer) { conditions.push("EXISTS (SELECT 1 FROM line_items li WHERE li.project_id=p.jetbuilt_id AND lower(li.manufacturer_raw)=lower(?))"); values.push(input.manufacturer); }
  if (input.model) { conditions.push("EXISTS (SELECT 1 FROM line_items li WHERE li.project_id=p.jetbuilt_id AND lower(li.model_raw)=lower(?))"); values.push(input.model); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM projects p LEFT JOIN clients c ON c.jetbuilt_id=p.client_id ${where}`;
  const total = Number((db.prepare(`SELECT count(*) count ${from}`).get(...values) as { count: number }).count);
  const items = db.prepare(`SELECT p.*, c.company_name_raw client_name_raw ${from} ORDER BY p.updated_at DESC, p.jetbuilt_id ASC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset);
  return { items, limit, offset, total, count: items.length, hasMore: offset + items.length < total };
}

export function getDeviceUsageHistory(db: DatabaseSync, manufacturer: string, model: string): Record<string, unknown> {
  const where = "lower(l.manufacturer_raw)=lower(?) AND lower(l.model_raw)=lower(?)";
  const summary = db.prepare(`SELECT count(*) totalMatchingLineItems,
    coalesce(sum(CASE WHEN l.quantity_state='valid' THEN l.quantity_numeric ELSE 0 END), 0) validQuantityTotal,
    count(DISTINCT l.project_id) projects, count(DISTINCT CASE WHEN l.room_id IS NOT NULL THEN l.project_id || ':' || l.room_id END) rooms,
    count(DISTINCT CASE WHEN l.system_id IS NOT NULL THEN l.project_id || ':' || l.system_id END) systems,
    min(l.source_created_at) firstSeen, max(coalesce(l.source_updated_at, l.source_created_at)) lastSeen
    FROM line_items l WHERE ${where}`).get(manufacturer, model) as Record<string, unknown>;
  const occurrences = db.prepare(`SELECT l.project_id, l.room_id, l.system_id, l.quantity_raw, l.quantity_numeric, l.quantity_state,
    l.source_created_at, l.source_updated_at FROM line_items l WHERE ${where} ORDER BY l.source_created_at, l.project_id, l.jetbuilt_id`)
    .all(manufacturer, model);
  return { ...summary, occurrences };
}

export function getRoomBom(db: DatabaseSync, projectId: string, roomId: string): unknown[] {
  return db.prepare(`SELECT l.*, s.name_raw system_name_raw, c.canonical_template_id, c.match_method
    FROM line_items l LEFT JOIN systems s ON s.project_id=l.project_id AND s.jetbuilt_id=l.system_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    WHERE l.project_id=? AND l.room_id=? ORDER BY lower(coalesce(l.manufacturer_raw,'')), lower(coalesce(l.model_raw,'')), l.jetbuilt_id`)
    .all(projectId, roomId);
}

export function getRoomDeviceCooccurrence(db: DatabaseSync, input: DeviceCooccurrenceInput): unknown[] {
  return getHistoryRoomDeviceCooccurrence(db, input).items as unknown[];
}

export function getUnmatchedHistoryLines(db: DatabaseSync, limit = 25, offset = 0): Record<string, unknown> {
  const base = `FROM line_items l LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    WHERE c.line_item_id IS NULL GROUP BY lower(l.manufacturer_raw), lower(l.model_raw)`;
  const total = Number((db.prepare(`SELECT count(*) count FROM (SELECT 1 ${base})`).get() as { count: number }).count);
  const items = db.prepare(`SELECT l.manufacturer_raw, l.model_raw, count(*) frequency, min(l.project_id) exampleProjectId,
    min(l.jetbuilt_id) exampleLineItemId ${base} ORDER BY frequency DESC, lower(l.manufacturer_raw), lower(l.model_raw) LIMIT ? OFFSET ?`)
    .all(Math.min(100, Math.max(1, limit)), Math.max(0, offset));
  return { items, total, count: items.length, limit: Math.min(100, Math.max(1, limit)), offset, hasMore: offset + items.length < total };
}
