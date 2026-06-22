import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SchematicFile } from "../../src/types.js";

const MAX_JSON_DEPTH = 64;
const MAX_SOURCE_LENGTH = 100;
const SCHEMATIC_ID_PREFIX = "sch_";
const SCHEMATIC_ID_PATTERN = /^sch_[a-f0-9]{32}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export class SchematicStoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SchematicStoreError";
    this.status = status;
  }
}

export interface SchematicSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  currentVersionSequence: number;
  currentHash: string;
  currentSizeBytes: number;
  createdByEmail: string | null;
  updatedByEmail: string | null;
}

export interface SchematicVersionSummary {
  sequence: number;
  title: string;
  contentHash: string;
  sizeBytes: number;
  source: string | null;
  createdAt: string;
  createdByEmail: string | null;
  isCurrent: boolean;
}

export interface SchematicDocument {
  schematic: SchematicSummary;
  version: SchematicVersionSummary;
  data: SchematicFile;
}

export interface SaveSchematicInput {
  schematic: unknown;
  source?: string;
  actorEmail?: string | null;
}

interface SchematicRow {
  id: string;
  title: string;
  current_version_id: string;
  current_hash: string;
  current_version_sequence: number;
  current_size_bytes: number;
  created_at: string;
  updated_at: string;
  created_by_email: string | null;
  updated_by_email: string | null;
}

interface SchematicVersionRow {
  id: string;
  schematic_id: string;
  version_sequence: number;
  title: string;
  content_hash: string;
  size_bytes: number;
  source: string | null;
  created_at: string;
  created_by_email: string | null;
}

interface PreparedSchematic {
  title: string;
  data: SchematicFile;
  canonicalJson: string;
  contentHash: string;
  sizeBytes: number;
}

function asSummary(row: SchematicRow): SchematicSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentVersionSequence: row.current_version_sequence,
    currentHash: row.current_hash,
    currentSizeBytes: row.current_size_bytes,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
  };
}

function asVersionSummary(row: SchematicVersionRow, currentVersionId: string): SchematicVersionSummary {
  return {
    sequence: row.version_sequence,
    title: row.title,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    source: row.source,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    isCurrent: row.id === currentVersionId,
  };
}

function assertSchematicId(id: string): void {
  if (!SCHEMATIC_ID_PATTERN.test(id)) {
    throw new SchematicStoreError(409, "Schematic repository metadata is invalid");
  }
}

function assertRequestedSchematicId(id: string): void {
  if (!SCHEMATIC_ID_PATTERN.test(id)) {
    throw new SchematicStoreError(400, "schematic id is invalid");
  }
}

function assertContentHash(hash: string): void {
  if (!CONTENT_HASH_PATTERN.test(hash)) {
    throw new SchematicStoreError(409, "Schematic repository metadata is invalid");
  }
}

function assertVersionSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new SchematicStoreError(400, "version sequence must be a positive integer");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalizeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new SchematicStoreError(400, `schematic JSON exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`);
  }

  if (
    value == null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SchematicStoreError(400, "schematic JSON must not contain non-finite numbers");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, depth + 1));
  }

  if (!isObject(value)) {
    throw new SchematicStoreError(400, "schematic JSON must contain only JSON-compatible values");
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalizeJson(value[key], depth + 1);
  }
  return output;
}

function normalizeSource(source: string | undefined, fallback: string): string {
  const value = (source ?? fallback).trim();
  if (!value) return fallback;
  if (value.length > MAX_SOURCE_LENGTH) {
    throw new SchematicStoreError(400, `source exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  return value;
}

function prepareSchematic(input: unknown, maxJsonBytes: number): PreparedSchematic {
  if (!isObject(input)) {
    throw new SchematicStoreError(400, "schematic must be an object");
  }

  if (typeof input.version !== "number" || !Number.isFinite(input.version)) {
    throw new SchematicStoreError(400, "schematic.version must be a number");
  }

  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new SchematicStoreError(400, "schematic.name must be a non-empty string");
  }

  if (!Array.isArray(input.nodes)) {
    throw new SchematicStoreError(400, "schematic.nodes must be an array");
  }

  if (!Array.isArray(input.edges)) {
    throw new SchematicStoreError(400, "schematic.edges must be an array");
  }

  const canonicalData = canonicalizeJson(input);
  const canonicalJson = JSON.stringify(canonicalData);
  const sizeBytes = Buffer.byteLength(canonicalJson);

  if (sizeBytes > maxJsonBytes) {
    throw new SchematicStoreError(400, `schematic JSON exceeds ${maxJsonBytes} bytes`);
  }

  return {
    title: input.name.trim(),
    data: canonicalData as SchematicFile,
    canonicalJson,
    contentHash: createHash("sha256").update(canonicalJson).digest("hex"),
    sizeBytes,
  };
}

function nextSchematicId(): string {
  return `${SCHEMATIC_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

function schematicDirectory(repositoryPath: string, schematicId: string): string {
  assertSchematicId(schematicId);
  return path.join(repositoryPath, "schematics", schematicId);
}

function currentPointerPath(repositoryPath: string, schematicId: string): string {
  return path.join(schematicDirectory(repositoryPath, schematicId), "current.sha256");
}

function versionPointerPath(repositoryPath: string, schematicId: string, sequence: number): string {
  return path.join(
    schematicDirectory(repositoryPath, schematicId),
    "versions",
    `${sequence.toString().padStart(6, "0")}.sha256`,
  );
}

function objectFilePath(repositoryPath: string, contentHash: string): string {
  assertContentHash(contentHash);
  return path.join(repositoryPath, "objects", contentHash.slice(0, 2), `${contentHash}.json`);
}

function atomicWriteFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function safeUnlink(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

function ensureStoredObject(repositoryPath: string, prepared: PreparedSchematic): void {
  const filePath = objectFilePath(repositoryPath, prepared.contentHash);
  if (existsSync(filePath)) {
    return;
  }
  atomicWriteFile(filePath, prepared.canonicalJson);
}

function readStoredObject(repositoryPath: string, contentHash: string): SchematicFile {
  const filePath = objectFilePath(repositoryPath, contentHash);
  if (!existsSync(filePath)) {
    throw new SchematicStoreError(409, "Schematic repository file is missing");
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const prepared = prepareSchematic(parsed, Number.MAX_SAFE_INTEGER);
    if (prepared.contentHash !== contentHash) {
      throw new SchematicStoreError(409, "Schematic repository integrity check failed");
    }
    return prepared.data;
  } catch (error) {
    if (error instanceof SchematicStoreError) {
      throw error;
    }
    throw new SchematicStoreError(409, "Schematic repository file is invalid");
  }
}

function readCurrentPointer(repositoryPath: string, schematicId: string): string {
  const filePath = currentPointerPath(repositoryPath, schematicId);
  if (!existsSync(filePath)) {
    throw new SchematicStoreError(409, "Schematic repository file is missing");
  }

  const contentHash = readFileSync(filePath, "utf8").trim();
  assertContentHash(contentHash);
  return contentHash;
}

function readVersionPointer(repositoryPath: string, schematicId: string, sequence: number): string {
  assertVersionSequence(sequence);
  const filePath = versionPointerPath(repositoryPath, schematicId, sequence);
  if (!existsSync(filePath)) {
    throw new SchematicStoreError(409, "Schematic repository file is missing");
  }

  const contentHash = readFileSync(filePath, "utf8").trim();
  assertContentHash(contentHash);
  return contentHash;
}

function readStoredSchematic(repositoryPath: string, schematicId: string, sequence?: number): SchematicFile {
  if (sequence == null) {
    return readStoredObject(repositoryPath, readCurrentPointer(repositoryPath, schematicId));
  }
  return readStoredObject(repositoryPath, readVersionPointer(repositoryPath, schematicId, sequence));
}

function logAudit(
  db: DatabaseSync,
  options: {
    schematicId: string;
    versionId?: string | null;
    action: string;
    actorEmail?: string | null;
    source?: string | null;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO schematic_audit_log (id, schematic_id, version_id, action, actor_email, source, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    options.schematicId,
    options.versionId ?? null,
    options.action,
    options.actorEmail ?? null,
    options.source ?? null,
    JSON.stringify(options.details ?? {}),
  );
}

function getSchematicRow(db: DatabaseSync, schematicId: string): SchematicRow | undefined {
  return db.prepare(`
    SELECT
      id,
      title,
      current_version_id,
      current_hash,
      current_version_sequence,
      current_size_bytes,
      created_at,
      updated_at,
      created_by_email,
      updated_by_email
    FROM schematics
    WHERE id = ?
  `).get(schematicId) as SchematicRow | undefined;
}

function getVersionRow(db: DatabaseSync, schematicId: string, sequence: number): SchematicVersionRow | undefined {
  return db.prepare(`
    SELECT
      id,
      schematic_id,
      version_sequence,
      title,
      content_hash,
      size_bytes,
      source,
      created_at,
      created_by_email
    FROM schematic_versions
    WHERE schematic_id = ? AND version_sequence = ?
  `).get(schematicId, sequence) as SchematicVersionRow | undefined;
}

function insertVersion(
  db: DatabaseSync,
  repositoryPath: string,
  options: {
    schematicId: string;
    sequence: number;
    prepared: PreparedSchematic;
    source: string;
    actorEmail?: string | null;
  },
): SchematicVersionRow {
  const versionId = randomUUID();
  ensureStoredObject(repositoryPath, options.prepared);
  atomicWriteFile(
    versionPointerPath(repositoryPath, options.schematicId, options.sequence),
    `${options.prepared.contentHash}\n`,
  );
  atomicWriteFile(
    currentPointerPath(repositoryPath, options.schematicId),
    `${options.prepared.contentHash}\n`,
  );

  db.prepare(`
    INSERT INTO schematic_versions (
      id,
      schematic_id,
      version_sequence,
      title,
      content_hash,
      size_bytes,
      source,
      created_by_email
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    options.schematicId,
    options.sequence,
    options.prepared.title,
    options.prepared.contentHash,
    options.prepared.sizeBytes,
    options.source,
    options.actorEmail ?? null,
  );

  return {
    id: versionId,
    schematic_id: options.schematicId,
    version_sequence: options.sequence,
    title: options.prepared.title,
    content_hash: options.prepared.contentHash,
    size_bytes: options.prepared.sizeBytes,
    source: options.source,
    created_at: new Date().toISOString(),
    created_by_email: options.actorEmail ?? null,
  };
}

function beginDeferredTransaction(db: DatabaseSync): void {
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys = ON");
}

export function listRecentSchematics(db: DatabaseSync): SchematicSummary[] {
  const rows = db.prepare(`
    SELECT
      id,
      title,
      current_version_id,
      current_hash,
      current_version_sequence,
      current_size_bytes,
      created_at,
      updated_at,
      created_by_email,
      updated_by_email
    FROM schematics
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 100
  `).all() as unknown as SchematicRow[];

  return rows.map(asSummary);
}

export function createSchematic(
  db: DatabaseSync,
  repositoryPath: string,
  maxJsonBytes: number,
  input: SaveSchematicInput,
): SchematicDocument {
  mkdirSync(repositoryPath, { recursive: true });
  const prepared = prepareSchematic(input.schematic, maxJsonBytes);
  const schematicId = nextSchematicId();
  const source = normalizeSource(input.source, "create");
  const currentPath = currentPointerPath(repositoryPath, schematicId);
  const versionPath = versionPointerPath(repositoryPath, schematicId, 1);

  beginDeferredTransaction(db);
  try {
    const version = insertVersion(db, repositoryPath, {
      schematicId,
      sequence: 1,
      prepared,
      source,
      actorEmail: input.actorEmail,
    });

    db.prepare(`
      INSERT INTO schematics (
        id,
        title,
        current_version_id,
        current_hash,
        current_version_sequence,
        current_size_bytes,
        created_by_email,
        updated_by_email
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      schematicId,
      prepared.title,
      version.id,
      prepared.contentHash,
      1,
      prepared.sizeBytes,
      input.actorEmail ?? null,
      input.actorEmail ?? null,
    );

    logAudit(db, {
      schematicId,
      versionId: version.id,
      action: "create",
      actorEmail: input.actorEmail,
      source,
      details: {
        sequence: 1,
        contentHash: prepared.contentHash,
        sizeBytes: prepared.sizeBytes,
      },
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    safeUnlink(versionPath);
    safeUnlink(currentPath);
    throw error;
  }

  return getCurrentSchematic(db, repositoryPath, schematicId);
}

export function getCurrentSchematic(db: DatabaseSync, repositoryPath: string, schematicId: string): SchematicDocument {
  assertRequestedSchematicId(schematicId);
  const row = getSchematicRow(db, schematicId);
  if (!row) {
    throw new SchematicStoreError(404, "Schematic not found");
  }

  const version = getVersionRow(db, schematicId, row.current_version_sequence);
  if (!version || version.id !== row.current_version_id) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  const currentHash = readCurrentPointer(repositoryPath, schematicId);
  if (currentHash !== row.current_hash) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  return {
    schematic: asSummary(row),
    version: asVersionSummary(version, row.current_version_id),
    data: readStoredObject(repositoryPath, row.current_hash),
  };
}

export function saveSchematic(
  db: DatabaseSync,
  repositoryPath: string,
  maxJsonBytes: number,
  schematicId: string,
  input: SaveSchematicInput,
): SchematicDocument & { createdNewVersion: boolean } {
  mkdirSync(repositoryPath, { recursive: true });
  assertRequestedSchematicId(schematicId);
  const existing = getSchematicRow(db, schematicId);
  if (!existing) {
    throw new SchematicStoreError(404, "Schematic not found");
  }

  const currentHash = readCurrentPointer(repositoryPath, schematicId);
  if (currentHash !== existing.current_hash) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  const prepared = prepareSchematic(input.schematic, maxJsonBytes);
  const source = normalizeSource(input.source, "save");
  const previousHash = existing.current_hash;
  const currentPath = currentPointerPath(repositoryPath, schematicId);
  const nextSequence = existing.current_version_sequence + 1;
  const versionPath = versionPointerPath(repositoryPath, schematicId, nextSequence);

  if (prepared.contentHash === existing.current_hash) {
    const current = getCurrentSchematic(db, repositoryPath, schematicId);
    logAudit(db, {
      schematicId,
      versionId: existing.current_version_id,
      action: "save-noop",
      actorEmail: input.actorEmail,
      source,
      details: {
        sequence: existing.current_version_sequence,
        contentHash: existing.current_hash,
      },
    });
    return { ...current, createdNewVersion: false };
  }

  beginDeferredTransaction(db);
  try {
    const version = insertVersion(db, repositoryPath, {
      schematicId,
      sequence: nextSequence,
      prepared,
      source,
      actorEmail: input.actorEmail,
    });

    db.prepare(`
      UPDATE schematics
      SET
        title = ?,
        current_version_id = ?,
        current_hash = ?,
        current_version_sequence = ?,
        current_size_bytes = ?,
        updated_at = datetime('now'),
        updated_by_email = ?
      WHERE id = ?
    `).run(
      prepared.title,
      version.id,
      prepared.contentHash,
      nextSequence,
      prepared.sizeBytes,
      input.actorEmail ?? null,
      schematicId,
    );

    logAudit(db, {
      schematicId,
      versionId: version.id,
      action: "save",
      actorEmail: input.actorEmail,
      source,
      details: {
        sequence: nextSequence,
        contentHash: prepared.contentHash,
        sizeBytes: prepared.sizeBytes,
      },
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    safeUnlink(versionPath);
    atomicWriteFile(currentPath, `${previousHash}\n`);
    throw error;
  }

  const current = getCurrentSchematic(db, repositoryPath, schematicId);
  return { ...current, createdNewVersion: true };
}

export function listSchematicVersions(
  db: DatabaseSync,
  schematicId: string,
): { schematic: SchematicSummary; versions: SchematicVersionSummary[] } {
  assertRequestedSchematicId(schematicId);
  const row = getSchematicRow(db, schematicId);
  if (!row) {
    throw new SchematicStoreError(404, "Schematic not found");
  }

  const versions = db.prepare(`
    SELECT
      id,
      schematic_id,
      version_sequence,
      title,
      content_hash,
      size_bytes,
      source,
      created_at,
      created_by_email
    FROM schematic_versions
    WHERE schematic_id = ?
    ORDER BY version_sequence DESC
  `).all(schematicId) as unknown as SchematicVersionRow[];

  return {
    schematic: asSummary(row),
    versions: versions.map((version) => asVersionSummary(version, row.current_version_id)),
  };
}

export function getSchematicVersion(
  db: DatabaseSync,
  repositoryPath: string,
  schematicId: string,
  sequence: number,
): SchematicDocument {
  assertRequestedSchematicId(schematicId);
  assertVersionSequence(sequence);
  const row = getSchematicRow(db, schematicId);
  if (!row) {
    throw new SchematicStoreError(404, "Schematic not found");
  }

  const version = getVersionRow(db, schematicId, sequence);
  if (!version) {
    throw new SchematicStoreError(404, "Schematic version not found");
  }

  const versionHash = readVersionPointer(repositoryPath, schematicId, sequence);
  if (versionHash !== version.content_hash) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  return {
    schematic: asSummary(row),
    version: asVersionSummary(version, row.current_version_id),
    data: readStoredObject(repositoryPath, version.content_hash),
  };
}

export function restoreSchematicVersion(
  db: DatabaseSync,
  repositoryPath: string,
  maxJsonBytes: number,
  schematicId: string,
  sequence: number,
  input: { source?: string; actorEmail?: string | null } = {},
): SchematicDocument {
  mkdirSync(repositoryPath, { recursive: true });
  assertRequestedSchematicId(schematicId);
  assertVersionSequence(sequence);
  const current = getSchematicRow(db, schematicId);
  if (!current) {
    throw new SchematicStoreError(404, "Schematic not found");
  }

  const currentHash = readCurrentPointer(repositoryPath, schematicId);
  if (currentHash !== current.current_hash) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  if (sequence === current.current_version_sequence) {
    throw new SchematicStoreError(409, "That version is already current");
  }

  const sourceVersion = getVersionRow(db, schematicId, sequence);
  if (!sourceVersion) {
    throw new SchematicStoreError(404, "Schematic version not found");
  }

  const versionHash = readVersionPointer(repositoryPath, schematicId, sequence);
  if (versionHash !== sourceVersion.content_hash) {
    throw new SchematicStoreError(409, "Schematic repository metadata is inconsistent");
  }

  const data = readStoredSchematic(repositoryPath, schematicId, sequence);
  const prepared = prepareSchematic(data, maxJsonBytes);
  const source = normalizeSource(input.source, "restore");
  const previousHash = current.current_hash;
  const currentPath = currentPointerPath(repositoryPath, schematicId);
  const nextSequence = current.current_version_sequence + 1;
  const versionPath = versionPointerPath(repositoryPath, schematicId, nextSequence);

  if (prepared.contentHash === current.current_hash) {
    throw new SchematicStoreError(409, "That version already matches the current schematic");
  }

  beginDeferredTransaction(db);
  try {
    const restored = insertVersion(db, repositoryPath, {
      schematicId,
      sequence: nextSequence,
      prepared,
      source,
      actorEmail: input.actorEmail,
    });

    db.prepare(`
      UPDATE schematics
      SET
        title = ?,
        current_version_id = ?,
        current_hash = ?,
        current_version_sequence = ?,
        current_size_bytes = ?,
        updated_at = datetime('now'),
        updated_by_email = ?
      WHERE id = ?
    `).run(
      prepared.title,
      restored.id,
      prepared.contentHash,
      nextSequence,
      prepared.sizeBytes,
      input.actorEmail ?? null,
      schematicId,
    );

    logAudit(db, {
      schematicId,
      versionId: restored.id,
      action: "restore",
      actorEmail: input.actorEmail,
      source,
      details: {
        restoredFromSequence: sequence,
        restoredToSequence: nextSequence,
        restoredFromVersionId: sourceVersion.id,
      },
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    safeUnlink(versionPath);
    atomicWriteFile(currentPath, `${previousHash}\n`);
    throw error;
  }

  return getCurrentSchematic(db, repositoryPath, schematicId);
}
