import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEVICE_TYPE_TO_CATEGORY } from "../../src/deviceTypeCategories.js";
import type { DeviceTemplate } from "../../src/types.js";
import { getTaxonomyVocabularies, listTaxonomyAliases, type TaxonomyAliasEntry } from "./taxonomy.js";

export type TaxonomyRegistryKind = "category" | "deviceType" | "roleTag" | "deviceCapability" | "protocol";
export type TaxonomyRegistryStatus = "active" | "deprecated";
export type TaxonomyRegistrySource = "builtin-seed" | "human" | "imported" | "system";
export type TaxonomyMigrationRisk = "low" | "medium" | "high";

export type TaxonomyRegistryOperation =
  | "create-value"
  | "update-metadata"
  | "deprecate-value"
  | "reactivate-value"
  | "create-alias"
  | "update-alias"
  | "deprecate-alias";

export class TaxonomyRegistryError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TaxonomyRegistryError";
    this.status = status;
  }
}

export interface TaxonomyRegistryValue {
  id: string;
  kind: TaxonomyRegistryKind;
  value: string;
  normalizedKey: string;
  label: string | null;
  description: string | null;
  parentValue: string | null;
  status: TaxonomyRegistryStatus;
  replacementValue: string | null;
  source: TaxonomyRegistrySource;
  version: number;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TaxonomyRegistryAlias {
  id: string;
  kind: TaxonomyRegistryKind;
  aliasValue: string;
  normalizedAliasKey: string;
  canonicalValue: string;
  migrationRisk: TaxonomyMigrationRisk;
  notes: string | null;
  status: TaxonomyRegistryStatus;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TaxonomyRegistryEvent {
  id: string;
  entityType: "value" | "alias";
  entityId: string;
  kind: TaxonomyRegistryKind;
  eventType: string;
  oldValue: unknown;
  newValue: unknown;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

export interface TaxonomyRegistryPreview {
  readOnly: true;
  operation: TaxonomyRegistryOperation;
  changeKey: string;
  current: unknown;
  proposed: unknown;
  impact: Record<string, unknown>;
}

interface ValueRow {
  id: string;
  kind: TaxonomyRegistryKind;
  value: string;
  normalized_key: string;
  label: string | null;
  description: string | null;
  parent_value: string | null;
  status: TaxonomyRegistryStatus;
  replacement_value: string | null;
  source: TaxonomyRegistrySource;
  version: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface AliasRow {
  id: string;
  kind: TaxonomyRegistryKind;
  alias_value: string;
  normalized_alias_key: string;
  canonical_value: string;
  migration_risk: TaxonomyMigrationRisk;
  notes: string | null;
  status: TaxonomyRegistryStatus;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface EventRow {
  id: string;
  entity_type: "value" | "alias";
  entity_id: string;
  kind: TaxonomyRegistryKind;
  event_type: string;
  old_value_json: string | null;
  new_value_json: string | null;
  actor: string | null;
  note: string | null;
  created_at: string;
}

const KINDS = new Set<TaxonomyRegistryKind>(["category", "deviceType", "roleTag", "deviceCapability", "protocol"]);
const SOURCES = new Set<TaxonomyRegistrySource>(["builtin-seed", "human", "imported", "system"]);
const RISKS = new Set<TaxonomyMigrationRisk>(["low", "medium", "high"]);

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TaxonomyRegistryError(400, `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > 500) throw new TaxonomyRegistryError(400, `${label} exceeds 500 characters`);
  return trimmed;
}

function optionalString(value: unknown, label: string, max = 2000): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TaxonomyRegistryError(400, `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new TaxonomyRegistryError(400, `${label} exceeds ${max} characters`);
  return trimmed;
}

function requireKind(value: unknown): TaxonomyRegistryKind {
  if (typeof value !== "string" || !KINDS.has(value as TaxonomyRegistryKind)) {
    throw new TaxonomyRegistryError(400, `kind must be one of: ${[...KINDS].join(", ")}`);
  }
  return value as TaxonomyRegistryKind;
}

function requireRisk(value: unknown): TaxonomyMigrationRisk {
  if (typeof value !== "string" || !RISKS.has(value as TaxonomyMigrationRisk)) {
    throw new TaxonomyRegistryError(400, `migrationRisk must be one of: ${[...RISKS].join(", ")}`);
  }
  return value as TaxonomyMigrationRisk;
}

function source(value: unknown): TaxonomyRegistrySource {
  if (value == null || value === "") return "human";
  if (typeof value !== "string" || !SOURCES.has(value as TaxonomyRegistrySource)) {
    throw new TaxonomyRegistryError(400, `source must be one of: ${[...SOURCES].join(", ")}`);
  }
  return value as TaxonomyRegistrySource;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function changeKey(operation: TaxonomyRegistryOperation, current: unknown, proposed: unknown, impact: unknown): string {
  return createHash("sha256").update(stableStringify({ operation, current, proposed, impact })).digest("hex");
}

function asValue(row: ValueRow): TaxonomyRegistryValue {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    normalizedKey: row.normalized_key,
    label: row.label,
    description: row.description,
    parentValue: row.parent_value,
    status: row.status,
    replacementValue: row.replacement_value,
    source: row.source,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function asAlias(row: AliasRow): TaxonomyRegistryAlias {
  return {
    id: row.id,
    kind: row.kind,
    aliasValue: row.alias_value,
    normalizedAliasKey: row.normalized_alias_key,
    canonicalValue: row.canonical_value,
    migrationRisk: row.migration_risk,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  return JSON.parse(raw) as unknown;
}

function asEvent(row: EventRow): TaxonomyRegistryEvent {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    kind: row.kind,
    eventType: row.event_type,
    oldValue: parseJson(row.old_value_json),
    newValue: parseJson(row.new_value_json),
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
  };
}

function getValueRow(db: DatabaseSync, kind: TaxonomyRegistryKind, value: string): ValueRow | undefined {
  return db.prepare(`
    SELECT * FROM taxonomy_registry_values
    WHERE kind = ? AND normalized_key = ?
  `).get(kind, normalizeKey(value)) as ValueRow | undefined;
}

function getAliasRow(db: DatabaseSync, kind: TaxonomyRegistryKind, aliasValue: string): AliasRow | undefined {
  return db.prepare(`
    SELECT * FROM taxonomy_registry_aliases
    WHERE kind = ? AND normalized_alias_key = ?
  `).get(kind, normalizeKey(aliasValue)) as AliasRow | undefined;
}

function appendEvent(
  db: DatabaseSync,
  entityType: "value" | "alias",
  entityId: string,
  kind: TaxonomyRegistryKind,
  eventType: string,
  oldValue: unknown,
  newValue: unknown,
  actor: string | null,
  note: string | null,
): void {
  db.prepare(`
    INSERT INTO taxonomy_registry_events (
      id, entity_type, entity_id, kind, event_type, old_value_json, new_value_json, actor, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    entityType,
    entityId,
    kind,
    eventType,
    oldValue === undefined ? null : JSON.stringify(oldValue),
    newValue === undefined ? null : JSON.stringify(newValue),
    actor,
    note,
  );
}

function insertSeedValue(db: DatabaseSync, kind: TaxonomyRegistryKind, value: string, parentValue: string | null): void {
  if (getValueRow(db, kind, value)) return;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO taxonomy_registry_values (
      id, kind, value, normalized_key, label, parent_value, source, created_by, updated_by
    )
    VALUES (?, ?, ?, ?, ?, ?, 'builtin-seed', 'system', 'system')
  `).run(id, kind, value, normalizeKey(value), value, parentValue);
  appendEvent(db, "value", id, kind, "seeded", null, { kind, value, parentValue, source: "builtin-seed" }, "system", null);
}

function registryKindForAlias(field: TaxonomyAliasEntry["field"]): TaxonomyRegistryKind | null {
  if (field === "category") return "category";
  if (field === "deviceType") return "deviceType";
  if (field === "roleTags") return "roleTag";
  if (field === "deviceCapabilities") return "deviceCapability";
  if (field === "protocols") return "protocol";
  return null;
}

function insertSeedAlias(
  db: DatabaseSync,
  kind: TaxonomyRegistryKind,
  aliasValue: string,
  canonicalValue: string,
  migrationRisk: TaxonomyMigrationRisk,
  notes: string | undefined,
): void {
  if (getAliasRow(db, kind, aliasValue)) return;
  const target = getValueRow(db, kind, canonicalValue);
  if (!target) return;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO taxonomy_registry_aliases (
      id, kind, alias_value, normalized_alias_key, canonical_value, migration_risk, notes, created_by, updated_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'system', 'system')
  `).run(id, kind, aliasValue, normalizeKey(aliasValue), target.value, migrationRisk, notes ?? null);
  appendEvent(db, "alias", id, kind, "seeded", null, { kind, aliasValue, canonicalValue: target.value, migrationRisk }, "system", null);
}

export function seedTaxonomyRegistry(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    const vocab = getTaxonomyVocabularies();
    for (const category of vocab.categories) insertSeedValue(db, "category", category, null);
    for (const { value, category } of vocab.deviceTypes) insertSeedValue(db, "deviceType", value, category);
    for (const value of vocab.roleTags) insertSeedValue(db, "roleTag", value, null);
    for (const value of vocab.deviceCapabilities) insertSeedValue(db, "deviceCapability", value, null);
    for (const value of vocab.protocols) insertSeedValue(db, "protocol", value, null);
    for (const entry of listTaxonomyAliases()) {
      const kind = registryKindForAlias(entry.field);
      if (!kind) continue;
      for (const alias of entry.aliases) insertSeedAlias(db, kind, alias, entry.canonicalValue, entry.migrationRisk, entry.notes);
      for (const alias of entry.deprecatedValues) insertSeedAlias(db, kind, alias, entry.canonicalValue, entry.migrationRisk, entry.notes);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new TaxonomyRegistryError(409, "Built-in taxonomy seed collides with existing registry values");
    }
    throw error;
  }
}

export function listRegistryValues(db: DatabaseSync, kind?: TaxonomyRegistryKind): TaxonomyRegistryValue[] {
  const rows = kind
    ? db.prepare("SELECT * FROM taxonomy_registry_values WHERE kind = ? ORDER BY lower(value), value").all(kind)
    : db.prepare("SELECT * FROM taxonomy_registry_values ORDER BY kind, lower(value), value").all();
  return (rows as unknown as ValueRow[]).map(asValue);
}

export function getRegistryValue(db: DatabaseSync, kind: TaxonomyRegistryKind, value: string): TaxonomyRegistryValue {
  const row = getValueRow(db, kind, value);
  if (!row) throw new TaxonomyRegistryError(404, "Registry value not found");
  return asValue(row);
}

export function listRegistryAliases(db: DatabaseSync, kind?: TaxonomyRegistryKind): TaxonomyRegistryAlias[] {
  const rows = kind
    ? db.prepare("SELECT * FROM taxonomy_registry_aliases WHERE kind = ? ORDER BY lower(alias_value), alias_value").all(kind)
    : db.prepare("SELECT * FROM taxonomy_registry_aliases ORDER BY kind, lower(alias_value), alias_value").all();
  return (rows as unknown as AliasRow[]).map(asAlias);
}

export function listRegistryHistory(db: DatabaseSync, entityType: "value" | "alias", id: string): TaxonomyRegistryEvent[] {
  const rows = db.prepare(`
    SELECT * FROM taxonomy_registry_events
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(entityType, id) as unknown as EventRow[];
  return rows.map(asEvent);
}

function countTemplates(templates: DeviceTemplate[], field: "category" | "deviceType", value: string): number {
  return templates.filter((template) => normalizeKey(String(template[field] ?? "")) === normalizeKey(value)).length;
}

function countAliasesTargeting(db: DatabaseSync, kind: TaxonomyRegistryKind, value: string): number {
  return Number((db.prepare(`
    SELECT count(*) AS count FROM taxonomy_registry_aliases
    WHERE kind = ? AND lower(canonical_value) = ?
  `).get(kind, normalizeKey(value)) as { count: number }).count);
}

function activeChildDeviceTypes(db: DatabaseSync, category: string): number {
  return Number((db.prepare(`
    SELECT count(*) AS count FROM taxonomy_registry_values
    WHERE kind = 'deviceType' AND status = 'active' AND lower(coalesce(parent_value, '')) = ?
  `).get(normalizeKey(category)) as { count: number }).count);
}

function validateValuePayload(db: DatabaseSync, input: Record<string, unknown>, forCreate: boolean) {
  const kind = requireKind(input.kind);
  const value = requireString(input.value, "value");
  const parentValue = optionalString(input.parentValue, "parentValue");
  if (kind !== "deviceType" && parentValue) throw new TaxonomyRegistryError(400, "parentValue is only valid for deviceType");
  if (kind === "deviceType") {
    const parent = parentValue ?? (forCreate ? null : undefined);
    if (parent === null) throw new TaxonomyRegistryError(400, "deviceType parentValue is required");
    if (parent) {
      const row = getValueRow(db, "category", parent);
      if (!row || row.status !== "active") throw new TaxonomyRegistryError(400, "deviceType parentValue must reference an active category");
    }
  }
  return {
    kind,
    value,
    parentValue,
    label: optionalString(input.label, "label"),
    description: optionalString(input.description, "description", 4000),
    source: source(input.source),
  };
}

function validateReplacement(db: DatabaseSync, kind: TaxonomyRegistryKind, value: string | null): string | null {
  if (!value) return null;
  const row = getValueRow(db, kind, value);
  if (!row || row.status !== "active") throw new TaxonomyRegistryError(400, "replacementValue must reference an active value of the same kind");
  return row.value;
}

export function previewTaxonomyRegistryChange(
  db: DatabaseSync,
  templates: DeviceTemplate[],
  input: Record<string, unknown>,
): TaxonomyRegistryPreview {
  const operation = requireString(input.operation, "operation") as TaxonomyRegistryOperation;
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : input;

  if (operation === "create-value") {
    const next = validateValuePayload(db, payload, true);
    const existing = getValueRow(db, next.kind, next.value);
    if (existing) throw new TaxonomyRegistryError(409, "Registry value already exists");
    const proposed = { ...next, status: "active" };
    const impact = {
      proposedCategory: next.kind === "deviceType" ? next.parentValue : null,
      collisions: 0,
      aliases: 0,
    };
    return {
      readOnly: true,
      operation,
      changeKey: changeKey(operation, null, proposed, impact),
      current: null,
      proposed,
      impact,
    };
  }

  if (operation === "update-metadata") {
    const kind = requireKind(payload.kind);
    const value = requireString(payload.value, "value");
    const current = getRegistryValue(db, kind, value);
    const proposed = {
      kind,
      value: current.value,
      label: optionalString(payload.label, "label") ?? current.label,
      description: optionalString(payload.description, "description", 4000) ?? current.description,
    };
    const impact = {};
    return { readOnly: true, operation, changeKey: changeKey(operation, current, proposed, impact), current, proposed, impact };
  }

  if (operation === "deprecate-value") {
    const kind = requireKind(payload.kind);
    const value = requireString(payload.value, "value");
    const current = getRegistryValue(db, kind, value);
    const replacementValue = validateReplacement(db, kind, optionalString(payload.replacementValue, "replacementValue"));
    if (replacementValue && normalizeKey(replacementValue) === normalizeKey(current.value)) {
      throw new TaxonomyRegistryError(400, "replacementValue cannot equal value");
    }
    const childDeviceTypes = kind === "category" ? activeChildDeviceTypes(db, current.value) : 0;
    if (kind === "category" && childDeviceTypes > 0) {
      throw new TaxonomyRegistryError(409, "Cannot deprecate category with active child deviceTypes");
    }
    const proposed = { kind, value: current.value, status: "deprecated", replacementValue };
    const impact = {
      templatesUsingValue: kind === "category" ? countTemplates(templates, "category", current.value) : kind === "deviceType" ? countTemplates(templates, "deviceType", current.value) : 0,
      aliasesTargetingValue: countAliasesTargeting(db, kind, current.value),
      activeChildDeviceTypes: childDeviceTypes,
      replacementValue,
    };
    return {
      readOnly: true,
      operation,
      changeKey: changeKey(operation, current, proposed, impact),
      current,
      proposed,
      impact,
    };
  }

  if (operation === "reactivate-value") {
    const kind = requireKind(payload.kind);
    const value = requireString(payload.value, "value");
    const current = getRegistryValue(db, kind, value);
    const proposed = { kind, value: current.value, status: "active", replacementValue: null };
    const impact = {};
    return { readOnly: true, operation, changeKey: changeKey(operation, current, proposed, impact), current, proposed, impact };
  }

  if (operation === "create-alias") {
    const kind = requireKind(payload.kind);
    const aliasValue = requireString(payload.aliasValue, "aliasValue");
    const canonicalValue = requireString(payload.canonicalValue, "canonicalValue");
    const target = getValueRow(db, kind, canonicalValue);
    if (!target || target.status !== "active") throw new TaxonomyRegistryError(400, "canonicalValue must reference an active registry value");
    if (normalizeKey(aliasValue) === normalizeKey(target.value)) throw new TaxonomyRegistryError(400, "aliasValue cannot equal canonicalValue");
    if (getValueRow(db, kind, aliasValue)) throw new TaxonomyRegistryError(409, "aliasValue collides with canonical registry value");
    if (getAliasRow(db, kind, aliasValue)) throw new TaxonomyRegistryError(409, "Alias already exists");
    const proposed = {
      kind,
      aliasValue,
      canonicalValue: target.value,
      migrationRisk: requireRisk(payload.migrationRisk),
      notes: optionalString(payload.notes, "notes", 4000),
      status: "active",
    };
    const impact = { templatesMutated: 0 };
    return { readOnly: true, operation, changeKey: changeKey(operation, null, proposed, impact), current: null, proposed, impact };
  }

  if (operation === "update-alias") {
    const kind = requireKind(payload.kind);
    const aliasValue = requireString(payload.aliasValue, "aliasValue");
    const current = getAliasRow(db, kind, aliasValue);
    if (!current) throw new TaxonomyRegistryError(404, "Alias not found");
    const proposed = {
      kind,
      aliasValue: current.alias_value,
      migrationRisk: payload.migrationRisk == null ? current.migration_risk : requireRisk(payload.migrationRisk),
      notes: payload.notes == null ? current.notes : optionalString(payload.notes, "notes", 4000),
    };
    const publicCurrent = asAlias(current);
    const impact = {};
    return { readOnly: true, operation, changeKey: changeKey(operation, publicCurrent, proposed, impact), current: publicCurrent, proposed, impact };
  }

  if (operation === "deprecate-alias") {
    const kind = requireKind(payload.kind);
    const aliasValue = requireString(payload.aliasValue, "aliasValue");
    const current = getAliasRow(db, kind, aliasValue);
    if (!current) throw new TaxonomyRegistryError(404, "Alias not found");
    const proposed = { kind, aliasValue: current.alias_value, status: "deprecated" };
    const publicCurrent = asAlias(current);
    const impact = { templatesMutated: 0 };
    return { readOnly: true, operation, changeKey: changeKey(operation, publicCurrent, proposed, impact), current: publicCurrent, proposed, impact };
  }

  throw new TaxonomyRegistryError(400, "Unsupported registry operation");
}

export function commitTaxonomyRegistryChange(
  db: DatabaseSync,
  templates: DeviceTemplate[],
  input: Record<string, unknown>,
): { preview: TaxonomyRegistryPreview; value?: TaxonomyRegistryValue; alias?: TaxonomyRegistryAlias } {
  const expectedKey = requireString(input.changeKey, "changeKey");
  const actor = optionalString(input.actor, "actor") ?? null;
  const note = optionalString(input.note, "note", 4000);
  const preview = previewTaxonomyRegistryChange(db, templates, input);
  if (preview.changeKey !== expectedKey) throw new TaxonomyRegistryError(409, "stale changeKey");

  db.exec("BEGIN");
  try {
    const proposed = preview.proposed as Record<string, unknown>;
    const kind = proposed.kind as TaxonomyRegistryKind;
    if (preview.operation === "create-value") {
      const id = randomUUID();
      const value = requireString(proposed.value, "value");
      db.prepare(`
        INSERT INTO taxonomy_registry_values (
          id, kind, value, normalized_key, label, description, parent_value, status, source, created_by, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        id,
        kind,
        value,
        normalizeKey(value),
        optionalString(proposed.label, "label"),
        optionalString(proposed.description, "description", 4000),
        optionalString(proposed.parentValue, "parentValue"),
        source(proposed.source),
        actor,
        actor,
      );
      appendEvent(db, "value", id, kind, "created", null, proposed, actor, note);
      db.exec("COMMIT");
      return { preview, value: getRegistryValue(db, kind, value) };
    }
    if (preview.operation === "update-metadata") {
      const current = preview.current as TaxonomyRegistryValue;
      db.prepare(`
        UPDATE taxonomy_registry_values
        SET label = ?, description = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
        WHERE id = ?
      `).run(optionalString(proposed.label, "label"), optionalString(proposed.description, "description", 4000), actor, current.id);
      appendEvent(db, "value", current.id, kind, "metadata-updated", preview.current, proposed, actor, note);
      db.exec("COMMIT");
      return { preview, value: getRegistryValue(db, kind, current.value) };
    }
    if (preview.operation === "deprecate-value" || preview.operation === "reactivate-value") {
      const current = preview.current as TaxonomyRegistryValue;
      db.prepare(`
        UPDATE taxonomy_registry_values
        SET status = ?, replacement_value = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
        WHERE id = ?
      `).run(requireString(proposed.status, "status"), optionalString(proposed.replacementValue, "replacementValue"), actor, current.id);
      appendEvent(db, "value", current.id, kind, preview.operation === "deprecate-value" ? "deprecated" : "reactivated", preview.current, proposed, actor, note);
      db.exec("COMMIT");
      return { preview, value: getRegistryValue(db, kind, current.value) };
    }
    if (preview.operation === "create-alias") {
      const id = randomUUID();
      const aliasValue = requireString(proposed.aliasValue, "aliasValue");
      db.prepare(`
        INSERT INTO taxonomy_registry_aliases (
          id, kind, alias_value, normalized_alias_key, canonical_value, migration_risk, notes, status, created_by, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id,
        kind,
        aliasValue,
        normalizeKey(aliasValue),
        requireString(proposed.canonicalValue, "canonicalValue"),
        requireRisk(proposed.migrationRisk),
        optionalString(proposed.notes, "notes", 4000),
        actor,
        actor,
      );
      appendEvent(db, "alias", id, kind, "alias-created", null, proposed, actor, note);
      db.exec("COMMIT");
      return { preview, alias: asAlias(getAliasRow(db, kind, aliasValue)!) };
    }
    if (preview.operation === "update-alias" || preview.operation === "deprecate-alias") {
      const current = preview.current as TaxonomyRegistryAlias;
      if (preview.operation === "update-alias") {
        db.prepare(`
          UPDATE taxonomy_registry_aliases
          SET migration_risk = ?, notes = ?, updated_at = datetime('now'), updated_by = ?
          WHERE id = ?
        `).run(requireRisk(proposed.migrationRisk), optionalString(proposed.notes, "notes", 4000), actor, current.id);
      } else {
        db.prepare(`
          UPDATE taxonomy_registry_aliases
          SET status = 'deprecated', updated_at = datetime('now'), updated_by = ?
          WHERE id = ?
        `).run(actor, current.id);
      }
      appendEvent(db, "alias", current.id, kind, preview.operation === "update-alias" ? "alias-updated" : "alias-deprecated", preview.current, proposed, actor, note);
      db.exec("COMMIT");
      return { preview, alias: asAlias(getAliasRow(db, kind, current.aliasValue)!) };
    }
    throw new TaxonomyRegistryError(400, "Unsupported registry operation");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new TaxonomyRegistryError(409, "Registry change conflicts with existing data");
    }
    throw error;
  }
}

export function dynamicRegistrySummary(db: DatabaseSync): Record<TaxonomyRegistryKind, number> {
  const summary = { category: 0, deviceType: 0, roleTag: 0, deviceCapability: 0, protocol: 0 };
  for (const row of db.prepare("SELECT kind, count(*) AS count FROM taxonomy_registry_values GROUP BY kind").all() as { kind: TaxonomyRegistryKind; count: number }[]) {
    summary[row.kind] = row.count;
  }
  return summary;
}

export function builtInDeviceTypeCategory(value: string): string | undefined {
  return DEVICE_TYPE_TO_CATEGORY[value];
}
