import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { JETBUILT_COHORTS, jetbuiltCohortSql, type JetbuiltCohort } from "./jetbuiltHistoryCohorts.js";
import {
  classifyJetbuiltHistoryLine,
  isSchematicRelevantForFingerprint,
  JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
  jetbuiltSchematicRelevanceV1RuleCount,
  type JetbuiltHistoryLineClassificationResult,
} from "./jetbuiltHistoryLineClassification.js";
import { normalizedLookupKey } from "./quoteImport.js";

type SqlValue = string | number;
type UnitKind = "room" | "system";

/** Explicit fingerprint modes for room/system intelligence. */
export const JETBUILT_FINGERPRINT_MODES = ["full-source", "schematic-relevant"] as const;
export type JetbuiltFingerprintMode = typeof JETBUILT_FINGERPRINT_MODES[number];

/** Design-intelligence defaults for common patterns and similar search. */
export const DEFAULT_DESIGN_FINGERPRINT_MODE: JetbuiltFingerprintMode = "schematic-relevant";

export interface JetbuiltHistoryScope {
  cohort?: JetbuiltCohort;
  from?: string;
  to?: string;
  dateBasis?: "created" | "updated";
  clientId?: string;
}

interface PageInput {
  limit?: number;
  offset?: number;
}

export interface JetbuiltBomEntry {
  identity: string;
  identityKind: "canonical" | "raw" | "unidentified";
  validQuantity: number;
  quantityStates: Record<string, number>;
  /** Aggregated line classifications contributing to this identity (audit). */
  classifications?: Array<{
    class: string;
    schematicRelevant: boolean | null;
    ruleId: string | null;
    lineCount: number;
  }>;
}

interface UnitRow {
  project_id: string;
  client_id: string | null;
  stage_raw: string | null;
  project_created_at: string | null;
  project_updated_at: string | null;
  unit_id: string;
  line_item_id: string | null;
  manufacturer_raw: string | null;
  model_raw: string | null;
  quantity_numeric: number | null;
  quantity_state: string | null;
  canonical_template_id: string | null;
  related_id: string | null;
}

interface ExclusionBucket {
  ruleId: string;
  class: string;
  reason: string | null;
  lineCount: number;
}

interface Bom {
  kind: UnitKind;
  projectId: string;
  unitId: string;
  clientId: string | null;
  stage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Full historical BOM truth — every retained line. */
  fullSourceEntries: JetbuiltBomEntry[];
  /** Derived schematic-relevant entries: excludes only schematicRelevant===false; retains unknown. */
  schematicRelevantEntries: JetbuiltBomEntry[];
  /** Order-independent SHA-256 of full-source entries. */
  fullSourceFingerprint: string;
  /**
   * Order-independent SHA-256 of schematic-relevant entries, or null when empty
   * after deterministic non-schematic exclusion (must not form reusable patterns).
   */
  schematicRelevantFingerprint: string | null;
  emptyAfterSchematicFiltering: boolean;
  exactMatchCount: number;
  lineItemCount: number;
  schematicRelevantLineItemCount: number;
  excludedLineItemCount: number;
  exclusions: ExclusionBucket[];
  classificationVersion: string;
  relatedIds: string[];
}

interface ScopeConditions {
  conditions: string[];
  values: SqlValue[];
  dateColumn: string;
}

function page(input: PageInput = {}): { limit: number; offset: number } {
  return {
    limit: Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25))),
    offset: Math.max(0, Math.trunc(input.offset ?? 0)),
  };
}

function scopeConditions(input: JetbuiltHistoryScope, alias = "p"): ScopeConditions {
  const cohort = jetbuiltCohortSql(input.cohort, `${alias}.stage_raw`);
  const conditions = cohort.sql === "1=1" ? [] : [cohort.sql];
  const values: SqlValue[] = [...cohort.values];
  const dateColumn = `${alias}.${input.dateBasis === "updated" ? "updated_at" : "created_at"}`;
  if (input.from) { conditions.push(`${dateColumn} >= ?`); values.push(input.from); }
  if (input.to) { conditions.push(`${dateColumn} <= ?`); values.push(input.to); }
  if (input.clientId) { conditions.push(`${alias}.client_id = ?`); values.push(input.clientId); }
  return { conditions, values, dateColumn };
}

function scopeCte(input: JetbuiltHistoryScope): { cte: string; values: SqlValue[] } {
  const scope = scopeConditions(input);
  return {
    cte: `WITH scoped_projects AS (SELECT p.jetbuilt_id FROM projects p${scope.conditions.length ? ` WHERE ${scope.conditions.join(" AND ")}` : ""})`,
    values: scope.values,
  };
}

function resolveFingerprintMode(mode: JetbuiltFingerprintMode | undefined, defaultMode: JetbuiltFingerprintMode): JetbuiltFingerprintMode {
  if (mode === "full-source" || mode === "schematic-relevant") return mode;
  return defaultMode;
}

function identity(row: UnitRow): { value: string; kind: JetbuiltBomEntry["identityKind"] } {
  if (row.canonical_template_id) return { value: `canonical:${row.canonical_template_id}`, kind: "canonical" };
  const raw = normalizedLookupKey(row.manufacturer_raw, row.model_raw);
  if (raw) return { value: `raw:${raw}`, kind: "raw" };
  return { value: `unidentified:${row.project_id}:${row.line_item_id}`, kind: "unidentified" };
}

function entryWeight(entry: JetbuiltBomEntry): number {
  if (entry.validQuantity > 0) return entry.validQuantity;
  return Math.max(1, Object.values(entry.quantityStates).reduce((total, count) => total + count, 0));
}

function coverage(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

function fingerprintEntries(entries: JetbuiltBomEntry[]): string {
  const normalizedEntries = entries
    .map((entry) => ({
      identity: entry.identity,
      identityKind: entry.identityKind,
      validQuantity: entry.validQuantity,
      quantityStates: Object.fromEntries(Object.entries(entry.quantityStates).sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return createHash("sha256").update(JSON.stringify(normalizedEntries)).digest("hex");
}

function sortEntries(entries: JetbuiltBomEntry[]): JetbuiltBomEntry[] {
  return [...entries]
    .map((entry) => ({
      ...entry,
      quantityStates: Object.fromEntries(Object.entries(entry.quantityStates).sort(([a], [b]) => a.localeCompare(b))),
      classifications: entry.classifications
        ? [...entry.classifications].sort((a, b) => a.class.localeCompare(b.class) || String(a.ruleId).localeCompare(String(b.ruleId)))
        : undefined,
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

function makeBoms(kind: UnitKind, rows: UnitRow[]): Bom[] {
  type EntryState = {
    entry: JetbuiltBomEntry;
    classificationCounts: Map<string, { class: string; schematicRelevant: boolean | null; ruleId: string | null; lineCount: number }>;
  };
  const boms = new Map<string, {
    bom: Omit<Bom, "fullSourceEntries" | "schematicRelevantEntries" | "fullSourceFingerprint" | "schematicRelevantFingerprint" | "emptyAfterSchematicFiltering" | "exclusions" | "relatedIds">;
    fullEntries: Map<string, EntryState>;
    schematicEntries: Map<string, EntryState>;
    exclusions: Map<string, ExclusionBucket>;
    relatedIds: Set<string>;
  }>();

  for (const row of rows) {
    const key = `${row.project_id}:${row.unit_id}`;
    let current = boms.get(key);
    if (!current) {
      current = {
        bom: {
          kind,
          projectId: row.project_id,
          unitId: row.unit_id,
          clientId: row.client_id,
          stage: row.stage_raw,
          createdAt: row.project_created_at,
          updatedAt: row.project_updated_at,
          exactMatchCount: 0,
          lineItemCount: 0,
          schematicRelevantLineItemCount: 0,
          excludedLineItemCount: 0,
          classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
        },
        fullEntries: new Map(),
        schematicEntries: new Map(),
        exclusions: new Map(),
        relatedIds: new Set(),
      };
      boms.set(key, current);
    }
    if (!row.line_item_id) continue;

    const classification = classifyJetbuiltHistoryLine(row.manufacturer_raw, row.model_raw);
    const keyIdentity = identity(row);
    const state = row.quantity_state ?? "missing";
    const applyEntry = (map: Map<string, EntryState>) => {
      let entryState = map.get(keyIdentity.value);
      if (!entryState) {
        entryState = {
          entry: { identity: keyIdentity.value, identityKind: keyIdentity.kind, validQuantity: 0, quantityStates: {} },
          classificationCounts: new Map(),
        };
        map.set(keyIdentity.value, entryState);
      }
      entryState.entry.quantityStates[state] = (entryState.entry.quantityStates[state] ?? 0) + 1;
      if (state === "valid" && row.quantity_numeric != null && row.quantity_numeric > 0) {
        entryState.entry.validQuantity += row.quantity_numeric;
      }
      const classKey = `${classification.class}|${classification.schematicRelevant}|${classification.ruleId ?? ""}`;
      const existing = entryState.classificationCounts.get(classKey);
      if (existing) existing.lineCount += 1;
      else {
        entryState.classificationCounts.set(classKey, {
          class: classification.class,
          schematicRelevant: classification.schematicRelevant,
          ruleId: classification.ruleId,
          lineCount: 1,
        });
      }
    };

    applyEntry(current.fullEntries);
    current.bom.lineItemCount += 1;
    if (row.canonical_template_id) current.bom.exactMatchCount += 1;
    if (row.related_id) current.relatedIds.add(row.related_id);

    if (isSchematicRelevantForFingerprint(classification)) {
      applyEntry(current.schematicEntries);
      current.bom.schematicRelevantLineItemCount += 1;
    } else {
      current.bom.excludedLineItemCount += 1;
      const ruleId = classification.ruleId ?? "unknown-exclusion";
      const existing = current.exclusions.get(ruleId);
      if (existing) existing.lineCount += 1;
      else {
        current.exclusions.set(ruleId, {
          ruleId,
          class: classification.class,
          reason: classification.reason,
          lineCount: 1,
        });
      }
    }
  }

  const finalizeEntries = (map: Map<string, EntryState>): JetbuiltBomEntry[] =>
    sortEntries([...map.values()].map(({ entry, classificationCounts }) => ({
      ...entry,
      classifications: [...classificationCounts.values()].sort((a, b) => a.class.localeCompare(b.class) || String(a.ruleId).localeCompare(String(b.ruleId))),
    })));

  return [...boms.values()].map(({ bom, fullEntries, schematicEntries, exclusions, relatedIds }) => {
    const fullSourceEntries = finalizeEntries(fullEntries);
    const schematicRelevantEntries = finalizeEntries(schematicEntries);
    const emptyAfterSchematicFiltering = bom.lineItemCount > 0 && schematicRelevantEntries.length === 0;
    return {
      ...bom,
      fullSourceEntries,
      schematicRelevantEntries,
      fullSourceFingerprint: fingerprintEntries(fullSourceEntries),
      schematicRelevantFingerprint: schematicRelevantEntries.length === 0 ? null : fingerprintEntries(schematicRelevantEntries),
      emptyAfterSchematicFiltering,
      exclusions: [...exclusions.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      relatedIds: [...relatedIds].sort(),
    };
  }).sort((a, b) => a.projectId.localeCompare(b.projectId) || a.unitId.localeCompare(b.unitId));
}

function loadBoms(
  db: DatabaseSync,
  kind: UnitKind,
  input: JetbuiltHistoryScope & { manufacturer?: string },
  selected?: { projectId: string; unitId: string },
): Bom[] {
  const scope = scopeConditions(input);
  const unitTable = kind === "room" ? "rooms" : "systems";
  const itemJoin = kind === "room" ? "l.room_id=u.jetbuilt_id" : "l.system_id=u.jetbuilt_id";
  const related = kind === "room" ? "l.system_id" : "l.room_id";
  const conditions = [...scope.conditions];
  const values: SqlValue[] = [...scope.values];
  if (selected) {
    conditions.push("u.project_id=?", "u.jetbuilt_id=?");
    values.push(selected.projectId, selected.unitId);
  }
  if (input.manufacturer) {
    conditions.push(`EXISTS (SELECT 1 FROM line_items m WHERE m.project_id=u.project_id AND ${kind === "room" ? "m.room_id" : "m.system_id"}=u.jetbuilt_id AND lower(coalesce(m.manufacturer_raw, ''))=lower(?))`);
    values.push(input.manufacturer);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT p.jetbuilt_id project_id, p.client_id, p.stage_raw, p.created_at project_created_at, p.updated_at project_updated_at,
    u.jetbuilt_id unit_id, l.jetbuilt_id line_item_id, l.manufacturer_raw, l.model_raw, l.quantity_numeric, l.quantity_state,
    c.canonical_template_id, ${related} related_id
    FROM ${unitTable} u JOIN projects p ON p.jetbuilt_id=u.project_id
    LEFT JOIN line_items l ON l.project_id=u.project_id AND ${itemJoin}
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    ${where}
    ORDER BY p.jetbuilt_id, u.jetbuilt_id, l.jetbuilt_id`).all(...values) as unknown as UnitRow[];
  return makeBoms(kind, rows);
}

function activeEntries(bom: Bom, mode: JetbuiltFingerprintMode): JetbuiltBomEntry[] {
  return mode === "full-source" ? bom.fullSourceEntries : bom.schematicRelevantEntries;
}

function activeFingerprint(bom: Bom, mode: JetbuiltFingerprintMode): string | null {
  return mode === "full-source" ? bom.fullSourceFingerprint : bom.schematicRelevantFingerprint;
}

function publicBom(bom: Bom, mode: JetbuiltFingerprintMode = "full-source"): Record<string, unknown> {
  const entries = activeEntries(bom, mode);
  const fingerprint = activeFingerprint(bom, mode);
  return {
    projectId: bom.projectId,
    [bom.kind === "room" ? "roomId" : "systemId"]: bom.unitId,
    clientId: bom.clientId,
    stage: bom.stage,
    fingerprintMode: mode,
    /** Selected-mode fingerprint (null when schematic-relevant is empty after filtering). */
    fingerprint,
    fullSourceFingerprint: bom.fullSourceFingerprint,
    schematicRelevantFingerprint: bom.schematicRelevantFingerprint,
    emptyAfterSchematicFiltering: bom.emptyAfterSchematicFiltering,
    classificationVersion: mode === "schematic-relevant" ? bom.classificationVersion : undefined,
    entries,
    fullSourceEntries: bom.fullSourceEntries,
    schematicRelevantEntries: bom.schematicRelevantEntries,
    validQuantityTotal: entries.reduce((total, entry) => total + entry.validQuantity, 0),
    exactMatchCoverage: coverage(bom.exactMatchCount, bom.lineItemCount),
    exactMatchCount: bom.exactMatchCount,
    lineItemCount: bom.lineItemCount,
    schematicRelevantLineItemCount: bom.schematicRelevantLineItemCount,
    excludedLineItemCount: bom.excludedLineItemCount,
    exclusions: bom.exclusions,
    relatedIds: bom.relatedIds,
  };
}

export function getRoomBomFingerprint(
  db: DatabaseSync,
  projectId: string,
  roomId: string,
  input: { fingerprintMode?: JetbuiltFingerprintMode } = {},
): Record<string, unknown> {
  const mode = resolveFingerprintMode(input.fingerprintMode, "full-source");
  const bom = loadBoms(db, "room", {}, { projectId, unitId: roomId })[0];
  if (!bom) throw new Error("Jetbuilt room was not found");
  return publicBom(bom, mode);
}

export function getSystemBom(
  db: DatabaseSync,
  projectId: string,
  systemId: string,
  input: { fingerprintMode?: JetbuiltFingerprintMode } = {},
): Record<string, unknown> {
  const mode = resolveFingerprintMode(input.fingerprintMode, "full-source");
  const bom = loadBoms(db, "system", {}, { projectId, unitId: systemId })[0];
  if (!bom) throw new Error("Jetbuilt system was not found");
  return publicBom(bom, mode);
}

export interface CommonPatternInput extends JetbuiltHistoryScope, PageInput {
  manufacturer?: string;
  minimumOccurrence?: number;
  canonicalMatchCoverage?: number;
  /**
   * full-source: every historical BOM line (audit/history).
   * schematic-relevant (default for design intelligence): excludes only deterministic non-schematic lines.
   */
  fingerprintMode?: JetbuiltFingerprintMode;
}

function commonPatterns(db: DatabaseSync, kind: UnitKind, input: CommonPatternInput = {}): Record<string, unknown> {
  const fingerprintMode = resolveFingerprintMode(input.fingerprintMode, DEFAULT_DESIGN_FINGERPRINT_MODE);
  const minimumOccurrence = Math.max(1, Math.trunc(input.minimumOccurrence ?? 2));
  const threshold = input.canonicalMatchCoverage == null ? 0 : Math.min(1, Math.max(0, input.canonicalMatchCoverage));
  const groups = new Map<string, Bom[]>();
  let emptyAfterSchematicFiltering = 0;
  let unitsWithLines = 0;
  let patternsSuppressedInternalOnly = 0;

  for (const bom of loadBoms(db, kind, input)) {
    if (bom.lineItemCount === 0) continue;
    unitsWithLines += 1;
    if (bom.emptyAfterSchematicFiltering) emptyAfterSchematicFiltering += 1;

    if (fingerprintMode === "schematic-relevant") {
      // Empty after deterministic non-schematic exclusion must not form reusable schematic patterns.
      if (bom.schematicRelevantFingerprint == null) {
        if (bom.emptyAfterSchematicFiltering) patternsSuppressedInternalOnly += 1;
        continue;
      }
      if (coverage(bom.exactMatchCount, bom.lineItemCount) < threshold) continue;
      groups.set(bom.schematicRelevantFingerprint, [...(groups.get(bom.schematicRelevantFingerprint) ?? []), bom]);
    } else {
      if (coverage(bom.exactMatchCount, bom.lineItemCount) < threshold) continue;
      groups.set(bom.fullSourceFingerprint, [...(groups.get(bom.fullSourceFingerprint) ?? []), bom]);
    }
  }

  const patterns = [...groups.entries()]
    .filter(([, boms]) => boms.length >= minimumOccurrence)
    .map(([fingerprint, boms]) => {
      const ordered = [...boms].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.unitId.localeCompare(b.unitId));
      const matchCount = ordered.reduce((total, bom) => total + bom.exactMatchCount, 0);
      const lineItemCount = ordered.reduce((total, bom) => total + bom.lineItemCount, 0);
      const entries = fingerprintMode === "full-source" ? ordered[0].fullSourceEntries : ordered[0].schematicRelevantEntries;
      return {
        fingerprint,
        fingerprintMode,
        classificationVersion: fingerprintMode === "schematic-relevant" ? JETBUILT_SCHEMATIC_RELEVANCE_VERSION : undefined,
        patternKind: "exact-bom-match" as const,
        terminologyNote: "exact BOM match / repeated BOM pattern — not claimed as the same design",
        [`${kind}Count`]: ordered.length,
        projectCount: new Set(ordered.map((bom) => bom.projectId)).size,
        clientCount: new Set(ordered.map((bom) => bom.clientId).filter((id): id is string => id != null)).size,
        firstSeen: ordered.map((bom) => bom.createdAt).filter((value): value is string => value != null).sort().at(0) ?? null,
        lastSeen: ordered.map((bom) => bom.updatedAt).filter((value): value is string => value != null).sort().at(-1) ?? null,
        examples: ordered.slice(0, 3).map((bom) => ({ projectId: bom.projectId, [kind === "room" ? "roomId" : "systemId"]: bom.unitId })),
        bomEntries: entries,
        exactMatchCoverage: coverage(matchCount, lineItemCount),
      };
    })
    .sort((a, b) => Number(b[`${kind}Count`]) - Number(a[`${kind}Count`]) || Number(b.projectCount) - Number(a.projectCount) || String(a.fingerprint).localeCompare(String(b.fingerprint)));

  const { limit, offset } = page(input);
  const items = patterns.slice(offset, offset + limit);
  return {
    fingerprintMode,
    classificationVersion: fingerprintMode === "schematic-relevant" ? JETBUILT_SCHEMATIC_RELEVANCE_VERSION : undefined,
    fingerprintModesSupported: [...JETBUILT_FINGERPRINT_MODES],
    defaultFingerprintMode: DEFAULT_DESIGN_FINGERPRINT_MODE,
    emptyAfterSchematicFiltering,
    unitsWithLines,
    patternsSuppressedBecauseOnlyDeterministicallyNonSchematic: fingerprintMode === "schematic-relevant" ? patternsSuppressedInternalOnly : 0,
    items,
    total: patterns.length,
    count: items.length,
    limit,
    offset,
    hasMore: offset + items.length < patterns.length,
  };
}

export function getCommonRoomBomPatterns(db: DatabaseSync, input: CommonPatternInput = {}): Record<string, unknown> {
  return commonPatterns(db, "room", input);
}

export function getCommonSystemBomPatterns(db: DatabaseSync, input: CommonPatternInput = {}): Record<string, unknown> {
  return commonPatterns(db, "system", input);
}

function setJaccard(left: readonly string[], right: readonly string[]): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  const shared = left.filter((value) => right.includes(value)).length;
  return shared / union.size;
}

/** Quantity-weighted identity Jaccard over BOM-line identities (not device-only unless entries are pre-filtered). */
function fullBomLineWeightedJaccard(
  sourceEntries: JetbuiltBomEntry[],
  candidateEntries: JetbuiltBomEntry[],
): {
  score: number;
  sharedIdentities: Array<Record<string, unknown>>;
  sourceOnly: string[];
  candidateOnly: string[];
  quantityDifferences: Array<Record<string, unknown>>;
} {
  const sourceByIdentity = new Map(sourceEntries.map((entry) => [entry.identity, entry]));
  const candidateByIdentity = new Map(candidateEntries.map((entry) => [entry.identity, entry]));
  const identities = [...new Set([...sourceByIdentity.keys(), ...candidateByIdentity.keys()])].sort();
  let sharedWeight = 0;
  let totalWeight = 0;
  const sharedIdentities: Array<Record<string, unknown>> = [];
  const sourceOnly: string[] = [];
  const candidateOnly: string[] = [];
  const quantityDifferences: Array<Record<string, unknown>> = [];
  for (const value of identities) {
    const sourceEntry = sourceByIdentity.get(value);
    const candidateEntry = candidateByIdentity.get(value);
    const sourceQuantity = sourceEntry ? entryWeight(sourceEntry) : 0;
    const candidateQuantity = candidateEntry ? entryWeight(candidateEntry) : 0;
    sharedWeight += Math.min(sourceQuantity, candidateQuantity);
    totalWeight += Math.max(sourceQuantity, candidateQuantity);
    if (sourceEntry && candidateEntry) {
      sharedIdentities.push({ identity: value, sourceQuantity, candidateQuantity });
      if (sourceQuantity !== candidateQuantity) quantityDifferences.push({ identity: value, sourceQuantity, candidateQuantity });
    } else if (sourceEntry) sourceOnly.push(value);
    else candidateOnly.push(value);
  }
  return {
    score: totalWeight === 0 ? 0 : sharedWeight / totalWeight,
    sharedIdentities,
    sourceOnly,
    candidateOnly,
    quantityDifferences,
  };
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compareBoms(source: Bom, candidate: Bom): Record<string, unknown> {
  const full = fullBomLineWeightedJaccard(source.fullSourceEntries, candidate.fullSourceEntries);
  const schematic = fullBomLineWeightedJaccard(source.schematicRelevantEntries, candidate.schematicRelevantEntries);
  /** Related system/room ID set Jaccard — composition evidence, not BOM-line device evidence. */
  const compositionScore = setJaccard(source.relatedIds, candidate.relatedIds);
  const sameClient = source.clientId != null && source.clientId === candidate.clientId;
  const sameStage = source.stage != null && source.stage === candidate.stage;
  const clientHint = sameClient ? 0.015 : 0;
  const stageHint = sameStage ? 0.005 : 0;
  const fullSourceSimilarityScore = roundScore(0.9 * full.score + 0.08 * compositionScore + clientHint + stageHint);
  const schematicRelevantSimilarityScore = roundScore(0.9 * schematic.score + 0.08 * compositionScore + clientHint + stageHint);
  const exactFullSourceFingerprintMatch = source.fullSourceFingerprint === candidate.fullSourceFingerprint;
  const exactSchematicRelevantFingerprintMatch =
    source.schematicRelevantFingerprint != null
    && candidate.schematicRelevantFingerprint != null
    && source.schematicRelevantFingerprint === candidate.schematicRelevantFingerprint;

  const reasons: string[] = [];
  if (exactFullSourceFingerprintMatch) reasons.push("exact-full-source-bom-fingerprint");
  if (exactSchematicRelevantFingerprintMatch) reasons.push("exact-schematic-relevant-bom-fingerprint");
  // Backward-compatible reason used by existing Phase 2 tests for exact full-source matches.
  if (exactFullSourceFingerprintMatch) reasons.push("exact-bom-fingerprint");
  if (schematic.sharedIdentities.length) reasons.push("shared-schematic-relevant-identities");
  if (full.sharedIdentities.length) reasons.push("shared-full-source-identities");
  if (compositionScore > 0) reasons.push("shared-system-or-room-composition");
  if (sameClient) reasons.push("same-client");
  if (sameStage) reasons.push("same-raw-stage");

  return {
    /** Design-intelligence primary rank score (schematic-relevant BOM evidence dominant). */
    similarityScore: schematicRelevantSimilarityScore,
    fullSourceSimilarityScore,
    schematicRelevantSimilarityScore,
    exactFullSourceFingerprintMatch,
    exactSchematicRelevantFingerprintMatch,
    /** Backward-compatible alias for full-source exact match. */
    exactFingerprintMatch: exactFullSourceFingerprintMatch,
    components: {
      fullBomLineWeightedJaccard: roundScore(full.score),
      schematicRelevantBomLineWeightedJaccard: roundScore(schematic.score),
      systemOrRoomCompositionJaccard: roundScore(compositionScore),
      sameClientHint: clientHint,
      sameStageHint: stageHint,
    },
    sharedDeviceIdentities: schematic.sharedIdentities,
    sharedFullSourceIdentities: full.sharedIdentities,
    sharedSchematicRelevantIdentities: schematic.sharedIdentities,
    sourceOnly: schematic.sourceOnly,
    candidateOnly: schematic.candidateOnly,
    fullSourceOnly: full.sourceOnly,
    fullCandidateOnly: full.candidateOnly,
    quantityDifferences: schematic.quantityDifferences,
    fullSourceQuantityDifferences: full.quantityDifferences,
    reasons,
  };
}

export interface SimilarityInput extends JetbuiltHistoryScope, PageInput {
  minimumScore?: number;
  /**
   * Ranking basis for minimumScore and sort order.
   * Default schematic-relevant for design intelligence; full-source remains available.
   */
  fingerprintMode?: JetbuiltFingerprintMode;
}

function similarUnits(db: DatabaseSync, kind: UnitKind, projectId: string, unitId: string, input: SimilarityInput = {}): Record<string, unknown> {
  const fingerprintMode = resolveFingerprintMode(input.fingerprintMode, DEFAULT_DESIGN_FINGERPRINT_MODE);
  const source = loadBoms(db, kind, {}, { projectId, unitId })[0];
  if (!source) throw new Error(`Jetbuilt ${kind} was not found`);
  const minimumScore = Math.min(1, Math.max(0, input.minimumScore ?? 0.01));
  const results = loadBoms(db, kind, input)
    .filter((candidate) => candidate.projectId !== source.projectId || candidate.unitId !== source.unitId)
    .map((candidate) => ({
      projectId: candidate.projectId,
      [kind === "room" ? "roomId" : "systemId"]: candidate.unitId,
      clientId: candidate.clientId,
      stage: candidate.stage,
      emptyAfterSchematicFiltering: candidate.emptyAfterSchematicFiltering,
      ...compareBoms(source, candidate),
    }))
    .filter((candidate) => {
      const score = fingerprintMode === "full-source"
        ? Number(candidate.fullSourceSimilarityScore)
        : Number(candidate.schematicRelevantSimilarityScore);
      return score >= minimumScore;
    })
    .sort((a, b) => {
      const scoreA = fingerprintMode === "full-source" ? Number(a.fullSourceSimilarityScore) : Number(a.schematicRelevantSimilarityScore);
      const scoreB = fingerprintMode === "full-source" ? Number(b.fullSourceSimilarityScore) : Number(b.schematicRelevantSimilarityScore);
      return scoreB - scoreA
        || String(a.projectId).localeCompare(String(b.projectId))
        || String(a[kind === "room" ? "roomId" : "systemId"]).localeCompare(String(b[kind === "room" ? "roomId" : "systemId"]));
    });
  const { limit, offset } = page(input);
  const items = results.slice(offset, offset + limit);
  return {
    fingerprintMode,
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    formula: fingerprintMode === "full-source"
      ? "0.90 × full BOM-line weighted Jaccard + 0.08 × system/room composition Jaccard + 0.015 same client + 0.005 same raw stage"
      : "0.90 × schematic-relevant BOM-line weighted Jaccard + 0.08 × system/room composition Jaccard + 0.015 same client + 0.005 same raw stage",
    similaritySemantics: {
      fullSource: "Quantity-weighted Jaccard over every retained historical BOM-line identity (canonical preferred, else normalized raw, else unidentified fallback). Not device-only.",
      schematicRelevant: "Same Jaccard algorithm over lines with schematicRelevant !== false under jetbuilt-schematic-relevance-v1. Unknown lines remain included. Known non-schematic lines are excluded.",
      composition: "Jaccard over related system IDs (for rooms) or room IDs (for systems). Not a device identity metric.",
      ranking: fingerprintMode === "full-source"
        ? "Ranked by fullSourceSimilarityScore"
        : "Ranked by schematicRelevantSimilarityScore (design-intelligence default); fullSourceSimilarityScore returned as secondary evidence",
    },
    source: publicBom(source, fingerprintMode),
    items,
    total: results.length,
    count: items.length,
    limit,
    offset,
    hasMore: offset + items.length < results.length,
  };
}

export function findSimilarRooms(db: DatabaseSync, projectId: string, roomId: string, input: SimilarityInput = {}): Record<string, unknown> {
  return similarUnits(db, "room", projectId, roomId, input);
}

export function findSimilarSystems(db: DatabaseSync, projectId: string, systemId: string, input: SimilarityInput = {}): Record<string, unknown> {
  return similarUnits(db, "system", projectId, systemId, input);
}

export interface DeviceCooccurrenceInput extends JetbuiltHistoryScope, PageInput {
  manufacturer?: string;
  model?: string;
  canonicalTemplateId?: string;
  minimumRoomCount?: number;
}

export function getHistoryRoomDeviceCooccurrence(db: DatabaseSync, input: DeviceCooccurrenceInput): Record<string, unknown> {
  if (!input.canonicalTemplateId && !(input.manufacturer && input.model)) throw new Error("manufacturer/model or canonicalTemplateId is required");
  const scope = scopeConditions(input);
  const target = input.canonicalTemplateId
    ? "EXISTS (SELECT 1 FROM line_items t JOIN canonical_template_links tc ON tc.project_id=t.project_id AND tc.line_item_id=t.jetbuilt_id WHERE t.project_id=l.project_id AND t.room_id=l.room_id AND tc.canonical_template_id=?)"
    : "EXISTS (SELECT 1 FROM line_items t WHERE t.project_id=l.project_id AND t.room_id=l.room_id AND lower(coalesce(t.manufacturer_raw, ''))=lower(?) AND lower(coalesce(t.model_raw, ''))=lower(?))";
  const targetValues: SqlValue[] = input.canonicalTemplateId ? [input.canonicalTemplateId] : [input.manufacturer as string, input.model as string];
  const exclusion = input.canonicalTemplateId
    ? "NOT EXISTS (SELECT 1 FROM canonical_template_links tc WHERE tc.project_id=l.project_id AND tc.line_item_id=l.jetbuilt_id AND tc.canonical_template_id=?)"
    : "NOT (lower(coalesce(l.manufacturer_raw, ''))=lower(?) AND lower(coalesce(l.model_raw, ''))=lower(?))";
  const exclusionValues: SqlValue[] = input.canonicalTemplateId ? [input.canonicalTemplateId] : [input.manufacturer as string, input.model as string];
  const minimumRoomCount = Math.max(1, Math.trunc(input.minimumRoomCount ?? 1));
  const conditions = ["l.room_id IS NOT NULL", target, exclusion, ...scope.conditions];
  const values = [...targetValues, ...exclusionValues, ...scope.values];
  const base = `FROM line_items l JOIN projects p ON p.jetbuilt_id=l.project_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY lower(coalesce(l.manufacturer_raw, '')), lower(coalesce(l.model_raw, ''))
    HAVING count(DISTINCT l.project_id || ':' || l.room_id) >= ?`;
  const total = Number((db.prepare(`SELECT count(*) count FROM (SELECT 1 ${base})`).get(...values, minimumRoomCount) as { count: number }).count);
  const { limit, offset } = page(input);
  const items = db.prepare(`SELECT l.manufacturer_raw manufacturer, l.model_raw model, l.manufacturer_raw, l.model_raw, min(c.canonical_template_id) canonicalTemplateId,
    CASE WHEN count(c.canonical_template_id) > 0 THEN 'canonical-or-raw' ELSE 'raw' END identityStatus,
    count(*) lineItemOccurrences, count(*) cooccurrenceCount, count(DISTINCT l.project_id || ':' || l.room_id) roomCount, count(DISTINCT l.project_id) projectCount,
    coalesce(sum(CASE WHEN l.quantity_state='valid' THEN l.quantity_numeric ELSE 0 END), 0) validQuantityTotal,
    min(${scope.dateColumn}) firstSeen, max(${scope.dateColumn}) lastSeen, min(l.project_id) exampleProjectId, min(l.room_id) exampleRoomId
    ${base}
    ORDER BY roomCount DESC, lineItemOccurrences DESC, lower(coalesce(l.manufacturer_raw, '')), lower(coalesce(l.model_raw, '')) LIMIT ? OFFSET ?`)
    .all(...values, minimumRoomCount, limit, offset);
  return { items, total, count: items.length, limit, offset, hasMore: offset + items.length < total };
}

export interface UsageTrendInput extends JetbuiltHistoryScope {
  groupBy?: "year" | "quarter";
  manufacturer?: string;
  model?: string;
}

function usageTrends(db: DatabaseSync, type: "manufacturer" | "model", input: UsageTrendInput = {}): Record<string, unknown> {
  const scope = scopeConditions(input);
  const conditions = [...scope.conditions, `${scope.dateColumn} IS NOT NULL`];
  const values: SqlValue[] = [...scope.values];
  if (input.manufacturer) { conditions.push("lower(coalesce(l.manufacturer_raw, ''))=lower(?)"); values.push(input.manufacturer); }
  if (input.model) { conditions.push("lower(coalesce(l.model_raw, ''))=lower(?)"); values.push(input.model); }
  const groupBy = input.groupBy ?? "year";
  const bucket = groupBy === "quarter"
    ? `strftime('%Y', ${scope.dateColumn}) || '-Q' || cast((cast(strftime('%m', ${scope.dateColumn}) AS integer) + 2) / 3 AS integer)`
    : `strftime('%Y', ${scope.dateColumn})`;
  const identity = type === "manufacturer"
    ? "coalesce(l.manufacturer_raw, '') manufacturer"
    : "coalesce(l.manufacturer_raw, '') manufacturer, coalesce(l.model_raw, '') model";
  const grouping = type === "manufacturer"
    ? "lower(coalesce(l.manufacturer_raw, ''))"
    : "lower(coalesce(l.manufacturer_raw, '')), lower(coalesce(l.model_raw, ''))";
  const items = db.prepare(`SELECT ${bucket} bucket, ${identity}, count(DISTINCT l.project_id) projectCount,
    count(DISTINCT CASE WHEN l.room_id IS NOT NULL THEN l.project_id || ':' || l.room_id END) roomCount,
    count(*) lineItemOccurrences, coalesce(sum(CASE WHEN l.quantity_state='valid' THEN l.quantity_numeric ELSE 0 END), 0) validQuantityTotal
    FROM line_items l JOIN projects p ON p.jetbuilt_id=l.project_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY ${bucket}, ${grouping}
    ORDER BY bucket, ${grouping}`).all(...values);
  return { dateBasis: input.dateBasis ?? "created", groupBy, items };
}

export function getManufacturerUsageTrends(db: DatabaseSync, input: UsageTrendInput = {}): Record<string, unknown> {
  return usageTrends(db, "manufacturer", input);
}

export function getModelUsageTrends(db: DatabaseSync, input: UsageTrendInput = {}): Record<string, unknown> {
  return usageTrends(db, "model", input);
}

export function getClientRoomPatterns(db: DatabaseSync, clientId: string, input: Omit<CommonPatternInput, "clientId"> = {}): Record<string, unknown> {
  return getCommonRoomBomPatterns(db, { ...input, clientId });
}

function coverageSummary(db: DatabaseSync, input: JetbuiltHistoryScope): Record<string, number> {
  const { cte, values } = scopeCte(input);
  const row = db.prepare(`${cte} SELECT count(*) lineItemCount,
    count(c.line_item_id) exactMatchedLineItems,
    coalesce(sum(CASE WHEN l.quantity_state='valid' THEN l.quantity_numeric ELSE 0 END), 0) validQuantityTotal,
    coalesce(sum(CASE WHEN l.quantity_state='valid' AND c.line_item_id IS NOT NULL THEN l.quantity_numeric ELSE 0 END), 0) exactMatchedValidQuantity
    FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id`).get(...values) as {
      lineItemCount: number; exactMatchedLineItems: number; validQuantityTotal: number; exactMatchedValidQuantity: number;
    };
  return {
    lineItemCount: Number(row.lineItemCount),
    exactMatchedLineItems: Number(row.exactMatchedLineItems),
    unmatchedLineItems: Number(row.lineItemCount) - Number(row.exactMatchedLineItems),
    exactMatchRateByOccurrence: coverage(Number(row.exactMatchedLineItems), Number(row.lineItemCount)),
    exactMatchRateByValidQuantity: coverage(Number(row.exactMatchedValidQuantity), Number(row.validQuantityTotal)),
  };
}

function classifyUnmatched(row: { manufacturer: string | null; model: string | null; kind: string | null }): string {
  const historical = classifyJetbuiltHistoryLine(row.manufacturer, row.model);
  if (historical.class !== "unknown") return historical.class;
  if (!row.manufacturer || !row.model) return "missing-device-identity";
  if (["labour", "labor", "service", "accessory"].includes((row.kind ?? "").trim().toLowerCase())) return "non-device-kind";
  return "unknown";
}

export function getHistoryCanonicalMatchCoverage(db: DatabaseSync, input: JetbuiltHistoryScope = {}): Record<string, unknown> {
  const { cte, values } = scopeCte(input);
  const byManufacturer = db.prepare(`${cte} SELECT coalesce(l.manufacturer_raw, '') manufacturer, count(*) lineItemCount,
    count(c.line_item_id) exactMatchedLineItems
    FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    GROUP BY lower(coalesce(l.manufacturer_raw, ''))
    ORDER BY exactMatchedLineItems * 1.0 / nullif(count(*), 0), lineItemCount DESC, lower(coalesce(l.manufacturer_raw, ''))`).all(...values)
    .map((row) => ({ ...row, exactMatchRate: coverage(Number((row as { exactMatchedLineItems: number }).exactMatchedLineItems), Number((row as { lineItemCount: number }).lineItemCount)) }));
  const topUnmatchedGroups = db.prepare(`${cte} SELECT l.manufacturer_raw manufacturer, l.model_raw model, l.kind_raw kind, count(*) lineItemCount,
    count(DISTINCT l.project_id) projectCount
    FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    WHERE c.line_item_id IS NULL
    GROUP BY lower(coalesce(l.manufacturer_raw, '')), lower(coalesce(l.model_raw, '')), lower(coalesce(l.kind_raw, ''))
    ORDER BY lineItemCount DESC, lower(coalesce(l.manufacturer_raw, '')), lower(coalesce(l.model_raw, '')) LIMIT 25`).all(...values)
    .map((row) => {
      const classification = classifyJetbuiltHistoryLine(
        (row as { manufacturer: string | null }).manufacturer,
        (row as { model: string | null }).model,
      );
      return {
        ...row,
        classification: classifyUnmatched(row as { manufacturer: string | null; model: string | null; kind: string | null }),
        historicalLineClassification: classification,
      };
    });
  const topMatchedTemplates = db.prepare(`${cte} SELECT c.canonical_template_id canonicalTemplateId, count(*) lineItemCount,
    count(DISTINCT l.project_id) projectCount
    FROM canonical_template_links c JOIN line_items l ON l.project_id=c.project_id AND l.jetbuilt_id=c.line_item_id
    JOIN scoped_projects s ON s.jetbuilt_id=l.project_id
    GROUP BY c.canonical_template_id ORDER BY lineItemCount DESC, canonicalTemplateId LIMIT 25`).all(...values);
  const cohorts = input.cohort ? [input.cohort] : JETBUILT_COHORTS;
  return {
    ...coverageSummary(db, input),
    byManufacturer,
    topUnmatchedGroups,
    topPoorCoverageManufacturers: byManufacturer.slice(0, 25),
    topMatchedTemplates,
    byCohort: cohorts.map((cohort) => ({ cohort, ...coverageSummary(db, { ...input, cohort }) })),
  };
}

export function getJetbuiltHistoryDataQuality(db: DatabaseSync, input: JetbuiltHistoryScope = {}): Record<string, unknown> {
  const { cte, values } = scopeCte(input);
  const scalar = (query: string): number => Number((db.prepare(`${cte} ${query}`).get(...values) as { count: number }).count);
  const totals = db.prepare(`${cte} SELECT count(*) projectCount, min(p.created_at) earliestProjectCreatedAt, max(p.created_at) latestProjectCreatedAt,
    min(p.updated_at) earliestProjectUpdatedAt, max(p.updated_at) latestProjectUpdatedAt FROM projects p JOIN scoped_projects s ON s.jetbuilt_id=p.jetbuilt_id`).get(...values) as Record<string, unknown>;
  const lineItemSummary = db.prepare(`${cte} SELECT
    sum(CASE WHEN l.room_id IS NULL THEN 1 ELSE 0 END) lineItemsMissingRoomId,
    sum(CASE WHEN l.system_id IS NULL THEN 1 ELSE 0 END) lineItemsMissingSystemId,
    sum(CASE WHEN l.room_id IS NOT NULL AND r.jetbuilt_id IS NULL THEN 1 ELSE 0 END) unresolvedRoomReferences,
    sum(CASE WHEN l.system_id IS NOT NULL AND sy.jetbuilt_id IS NULL THEN 1 ELSE 0 END) unresolvedSystemReferences,
    sum(CASE WHEN l.quantity_state='malformed' THEN 1 ELSE 0 END) malformedQuantities,
    sum(CASE WHEN l.quantity_state='zero' THEN 1 ELSE 0 END) zeroQuantities,
    sum(CASE WHEN l.quantity_state='negative' THEN 1 ELSE 0 END) negativeQuantities,
    sum(CASE WHEN trim(coalesce(l.manufacturer_raw, ''))='' THEN 1 ELSE 0 END) missingManufacturer,
    sum(CASE WHEN trim(coalesce(l.model_raw, ''))='' THEN 1 ELSE 0 END) missingModel,
    count(*) lineItemCount, count(c.line_item_id) exactMatchedLineItems
    FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id
    LEFT JOIN rooms r ON r.project_id=l.project_id AND r.jetbuilt_id=l.room_id
    LEFT JOIN systems sy ON sy.project_id=l.project_id AND sy.jetbuilt_id=l.system_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id`).get(...values) as Record<string, unknown>;
  const duplicateChildIds = {
    room: scalar("SELECT count(*) count FROM (SELECT r.jetbuilt_id FROM rooms r JOIN scoped_projects s ON s.jetbuilt_id=r.project_id GROUP BY r.jetbuilt_id HAVING count(DISTINCT r.project_id)>1)"),
    system: scalar("SELECT count(*) count FROM (SELECT sy.jetbuilt_id FROM systems sy JOIN scoped_projects s ON s.jetbuilt_id=sy.project_id GROUP BY sy.jetbuilt_id HAVING count(DISTINCT sy.project_id)>1)"),
    lineItem: scalar("SELECT count(*) count FROM (SELECT l.jetbuilt_id FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id GROUP BY l.jetbuilt_id HAVING count(DISTINCT l.project_id)>1)"),
  };
  const stagesObserved = db.prepare(`${cte} SELECT coalesce(lower(p.stage_raw), 'unknown') stage, count(*) projectCount
    FROM projects p JOIN scoped_projects s ON s.jetbuilt_id=p.jetbuilt_id GROUP BY coalesce(lower(p.stage_raw), 'unknown') ORDER BY stage`).all(...values);
  const exactMatchedLineItems = Number(lineItemSummary.exactMatchedLineItems ?? 0);
  const lineItemCount = Number(lineItemSummary.lineItemCount ?? 0);
  return {
    ...totals,
    roomCount: scalar("SELECT count(*) count FROM rooms r JOIN scoped_projects s ON s.jetbuilt_id=r.project_id"),
    projectsWithZeroRooms: scalar("SELECT count(*) count FROM scoped_projects s WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.project_id=s.jetbuilt_id)"),
    systemCount: scalar("SELECT count(*) count FROM systems sy JOIN scoped_projects s ON s.jetbuilt_id=sy.project_id"),
    projectsWithZeroSystems: scalar("SELECT count(*) count FROM scoped_projects s WHERE NOT EXISTS (SELECT 1 FROM systems sy WHERE sy.project_id=s.jetbuilt_id)"),
    ...lineItemSummary,
    exactMatchRate: coverage(exactMatchedLineItems, lineItemCount),
    unmatchedRate: coverage(lineItemCount - exactMatchedLineItems, lineItemCount),
    duplicateChildIds,
    stagesObserved,
  };
}

/** Summarize classification over all line items in scope (for artifacts / reporting). */
export function getHistoricalLineClassificationSummary(db: DatabaseSync, input: JetbuiltHistoryScope = {}): Record<string, unknown> {
  const { cte, values } = scopeCte(input);
  const rows = db.prepare(`${cte} SELECT l.manufacturer_raw manufacturer, l.model_raw model
    FROM line_items l JOIN scoped_projects s ON s.jetbuilt_id=l.project_id`).all(...values) as Array<{ manufacturer: string | null; model: string | null }>;
  const byClass: Record<string, number> = {};
  let nonSchematic = 0;
  let unknown = 0;
  for (const row of rows) {
    const result = classifyJetbuiltHistoryLine(row.manufacturer, row.model);
    byClass[result.class] = (byClass[result.class] ?? 0) + 1;
    if (result.schematicRelevant === false) nonSchematic += 1;
    if (result.class === "unknown") unknown += 1;
  }
  return {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    exactV1RuleCount: jetbuiltSchematicRelevanceV1RuleCount(),
    lineItemCount: rows.length,
    deterministicallyNonSchematicLineCount: nonSchematic,
    unknownLineCount: unknown,
    lineCountsByClass: Object.fromEntries(Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Summarize repeated exact BOM patterns for reporting (paginates through all pattern pages). */
export function summarizeRepeatedPatterns(
  db: DatabaseSync,
  kind: UnitKind,
  fingerprintMode: JetbuiltFingerprintMode,
  input: JetbuiltHistoryScope = {},
): {
  fingerprintMode: JetbuiltFingerprintMode;
  classificationVersion?: string;
  repeatedPatternCount: number;
  crossProjectRepeatedPatternCount: number;
  crossClientRepeatedPatternCount: number;
  largestPatternUnitCount: number;
  largestPatternProjectCount: number;
  emptyAfterSchematicFiltering: number;
  patternsSuppressedBecauseOnlyDeterministicallyNonSchematic: number;
} {
  const collected: Array<Record<string, unknown>> = [];
  let offset = 0;
  let total = 0;
  let emptyAfterSchematicFiltering = 0;
  let patternsSuppressedBecauseOnlyDeterministicallyNonSchematic = 0;
  do {
    const pageResult = commonPatterns(db, kind, { ...input, minimumOccurrence: 2, fingerprintMode, limit: 100, offset });
    total = Number(pageResult.total);
    emptyAfterSchematicFiltering = Number(pageResult.emptyAfterSchematicFiltering ?? 0);
    patternsSuppressedBecauseOnlyDeterministicallyNonSchematic = Number(pageResult.patternsSuppressedBecauseOnlyDeterministicallyNonSchematic ?? 0);
    collected.push(...(pageResult.items as Array<Record<string, unknown>>));
    offset += 100;
  } while (offset < total);

  const unitKey = `${kind}Count`;
  return {
    fingerprintMode,
    classificationVersion: fingerprintMode === "schematic-relevant" ? JETBUILT_SCHEMATIC_RELEVANCE_VERSION : undefined,
    repeatedPatternCount: total,
    crossProjectRepeatedPatternCount: collected.filter((item) => Number(item.projectCount) > 1).length,
    crossClientRepeatedPatternCount: collected.filter((item) => Number(item.clientCount) > 1).length,
    largestPatternUnitCount: collected.reduce((max, item) => Math.max(max, Number(item[unitKey] ?? 0)), 0),
    largestPatternProjectCount: collected.reduce((max, item) => Math.max(max, Number(item.projectCount ?? 0)), 0),
    emptyAfterSchematicFiltering,
    patternsSuppressedBecauseOnlyDeterministicallyNonSchematic,
  };
}

// Re-export classification primitives for callers/tests without scattering logic.
export {
  classifyJetbuiltHistoryLine,
  JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
  jetbuiltSchematicRelevanceV1RuleCount,
  listJetbuiltSchematicRelevanceV1Rules,
  isSchematicRelevantForFingerprint,
} from "./jetbuiltHistoryLineClassification.js";

export type { JetbuiltHistoryLineClassificationResult };
