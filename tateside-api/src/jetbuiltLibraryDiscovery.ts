import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import { listCurrentTemplates } from "./deviceStore.js";
import {
  isProjectInJetbuiltCohort,
  JETBUILT_COHORTS,
  jetbuiltCohortSql,
  normalizeJetbuiltStage,
  type JetbuiltCohort,
} from "./jetbuiltHistoryCohorts.js";
import {
  classifyJetbuiltHistoryLine,
  JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
  type JetbuiltHistoryLineClassificationResult,
} from "./jetbuiltHistoryLineClassification.js";
import { JETBUILT_HISTORY_MATCHER_VERSION } from "./jetbuiltHistoryStore.js";
import { normalizedLookupKey } from "./quoteImport.js";

type SqlValue = string | number;

export const JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION = "jetbuilt-library-discovery-priority-v1";

export interface JetbuiltDiscoveryScope {
  cohort?: JetbuiltCohort;
  stage?: string;
  manufacturer?: string;
  from?: string;
  to?: string;
  dateBasis?: "created" | "updated";
}

export interface JetbuiltCandidateListInput extends JetbuiltDiscoveryScope {
  limit?: number;
  offset?: number;
  minimumProjectCount?: number;
  minimumRoomCount?: number;
  minimumDeliveredOrInstalledProjectCount?: number;
  /** Default true: exclude lines with schematicRelevant === false. */
  excludeKnownNonSchematic?: boolean;
  /**
   * Default false (unmatched only). When true, include exact-matched identities.
   * When false, only candidates without exact canonical links are returned.
   */
  exactCanonicalMatch?: boolean;
  minimumPriorityScore?: number;
}

export interface JetbuiltDiscoveryCandidate {
  candidateKey: string;
  manufacturerRawExamples: string[];
  modelRawExamples: string[];
  normalizedManufacturer: string;
  normalizedModel: string;
  exactCanonicalMatch: boolean;
  exactMatchedLineItemCount: number;
  unmatchedLineItemCount: number;
  classification: JetbuiltHistoryLineClassificationResult;
  lineItemOccurrences: number;
  validQuantityTotal: number;
  roomCount: number;
  systemCount: number;
  projectCount: number;
  clientCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  rawStagesObserved: string[];
  cohortCounts: Record<string, number>;
  installProjectCount: number;
  completedProjectCount: number;
  deliveredOrInstalledProjectCount: number;
  activeCommercialProjectCount: number;
  priorityScore: number;
  priorityReasons: string[];
  rankingVersion: string;
  exampleProjectIds: string[];
  exampleRoomIds: string[];
}

interface LineRow {
  project_id: string;
  client_id: string | null;
  stage_raw: string | null;
  project_created_at: string | null;
  project_updated_at: string | null;
  line_item_id: string;
  room_id: string | null;
  system_id: string | null;
  manufacturer_raw: string | null;
  model_raw: string | null;
  quantity_numeric: number | null;
  quantity_state: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  canonical_template_id: string | null;
}

interface Accumulator {
  candidateKey: string;
  normalizedManufacturer: string;
  normalizedModel: string;
  manufacturerRawExamples: Set<string>;
  modelRawExamples: Set<string>;
  classification: JetbuiltHistoryLineClassificationResult;
  lineItemOccurrences: number;
  exactMatchedLineItemCount: number;
  unmatchedLineItemCount: number;
  validQuantityTotal: number;
  rooms: Set<string>;
  systems: Set<string>;
  projects: Set<string>;
  clients: Set<string>;
  installProjects: Set<string>;
  completedProjects: Set<string>;
  deliveredProjects: Set<string>;
  activeCommercialProjects: Set<string>;
  stages: Set<string>;
  projectStages: Map<string, string | null>;
  firstSeen: string | null;
  lastSeen: string | null;
  exampleProjectIds: string[];
  exampleRoomIds: string[];
}

function page(input: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: Math.min(100, Math.max(1, Math.trunc(input.limit ?? 25))),
    offset: Math.max(0, Math.trunc(input.offset ?? 0)),
  };
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function candidateKeyFromRaw(manufacturer: string | null | undefined, model: string | null | undefined): string | null {
  const key = normalizedLookupKey(manufacturer, model);
  if (!key || !key.includes("::")) return null;
  return key;
}

function splitCandidateKey(key: string): { normalizedManufacturer: string; normalizedModel: string } {
  const [normalizedManufacturer = "", normalizedModel = ""] = key.split("::");
  return { normalizedManufacturer, normalizedModel };
}

function minIso(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  return next < current ? next : current;
}

function maxIso(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  return next > current ? next : current;
}

function daysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (nowMs - parsed) / (24 * 60 * 60 * 1000));
}

/**
 * Deterministic triage ranking. Not truth.
 * Quantity is evidence only and does not dominate (no direct qty term).
 *
 * Weights:
 * - delivered-or-installed distinct projects: 12 each (cap 10 → max 120)
 * - completed distinct projects: 8 each (cap 10 → max 80)
 * - install distinct projects: 6 each (cap 10 → max 60)
 * - all distinct projects: 4 each (cap 15 → max 60)
 * - distinct rooms: 1.5 each (cap 20 → max 30)
 * - recency: last 90d +20, last 365d +12, last 3y +5
 * - identity quality: manufacturer+model present +8
 */
export function scoreJetbuiltDiscoveryCandidate(
  evidence: {
    deliveredOrInstalledProjectCount: number;
    completedProjectCount: number;
    installProjectCount: number;
    projectCount: number;
    roomCount: number;
    lastSeen: string | null;
    hasManufacturerAndModel: boolean;
  },
  nowMs = Date.now(),
): { priorityScore: number; priorityReasons: string[] } {
  const delivered = Math.min(10, Math.max(0, evidence.deliveredOrInstalledProjectCount));
  const completed = Math.min(10, Math.max(0, evidence.completedProjectCount));
  const install = Math.min(10, Math.max(0, evidence.installProjectCount));
  const projects = Math.min(15, Math.max(0, evidence.projectCount));
  const rooms = Math.min(20, Math.max(0, evidence.roomCount));

  let score = 0;
  const reasons: string[] = [];

  score += delivered * 12;
  if (evidence.deliveredOrInstalledProjectCount > 0) {
    reasons.push(`seen in ${evidence.deliveredOrInstalledProjectCount} delivered-or-installed project${evidence.deliveredOrInstalledProjectCount === 1 ? "" : "s"}`);
  }

  score += completed * 8;
  if (evidence.completedProjectCount > 0) {
    reasons.push(`seen in ${evidence.completedProjectCount} completed project${evidence.completedProjectCount === 1 ? "" : "s"}`);
  }

  score += install * 6;
  if (evidence.installProjectCount > 0) {
    reasons.push(`seen in ${evidence.installProjectCount} install project${evidence.installProjectCount === 1 ? "" : "s"}`);
  }

  score += projects * 4;
  if (evidence.projectCount > 0) {
    reasons.push(`seen across ${evidence.projectCount} project${evidence.projectCount === 1 ? "" : "s"}`);
  }

  score += rooms * 1.5;
  if (evidence.roomCount > 0) {
    reasons.push(`seen across ${evidence.roomCount} room${evidence.roomCount === 1 ? "" : "s"}`);
  }

  const ageDays = daysSince(evidence.lastSeen, nowMs);
  if (ageDays != null) {
    if (ageDays <= 90) {
      score += 20;
      reasons.push("used within the last 90 days");
    } else if (ageDays <= 365) {
      score += 12;
      reasons.push("used within the last 12 months");
    } else if (ageDays <= 365 * 3) {
      score += 5;
      reasons.push("used within the last 3 years");
    }
  }

  if (evidence.hasManufacturerAndModel) {
    score += 8;
    reasons.push("manufacturer and model identity both present");
  }

  // Stable two-decimal triage score; not authoritative truth.
  const priorityScore = Math.round(score * 100) / 100;
  return { priorityScore, priorityReasons: reasons };
}

function scopeSql(input: JetbuiltDiscoveryScope): { conditions: string[]; values: SqlValue[]; dateColumn: string } {
  const cohort = jetbuiltCohortSql(input.cohort, "p.stage_raw");
  const conditions = cohort.sql === "1=1" ? [] : [cohort.sql];
  const values: SqlValue[] = [...cohort.values];
  const dateColumn = `p.${input.dateBasis === "updated" ? "updated_at" : "created_at"}`;
  if (input.stage) {
    conditions.push("lower(coalesce(p.stage_raw, '')) = lower(?)");
    values.push(input.stage);
  }
  if (input.manufacturer) {
    conditions.push("lower(coalesce(l.manufacturer_raw, '')) = lower(?)");
    values.push(input.manufacturer);
  }
  if (input.from) {
    conditions.push(`${dateColumn} >= ?`);
    values.push(input.from);
  }
  if (input.to) {
    conditions.push(`${dateColumn} <= ?`);
    values.push(input.to);
  }
  return { conditions, values, dateColumn };
}

function loadLineRows(db: DatabaseSync, input: JetbuiltDiscoveryScope = {}): LineRow[] {
  const scope = scopeSql(input);
  const where = scope.conditions.length ? `WHERE ${scope.conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT p.jetbuilt_id project_id, p.client_id, p.stage_raw, p.created_at project_created_at, p.updated_at project_updated_at,
    l.jetbuilt_id line_item_id, l.room_id, l.system_id, l.manufacturer_raw, l.model_raw, l.quantity_numeric, l.quantity_state,
    l.source_created_at, l.source_updated_at, c.canonical_template_id
    FROM line_items l
    JOIN projects p ON p.jetbuilt_id = l.project_id
    LEFT JOIN canonical_template_links c ON c.project_id = l.project_id AND c.line_item_id = l.jetbuilt_id
    ${where}
    ORDER BY p.jetbuilt_id, l.jetbuilt_id`).all(...scope.values) as unknown as LineRow[];
}

function accumulateCandidates(rows: LineRow[], nowMs = Date.now()): Map<string, Accumulator> {
  const map = new Map<string, Accumulator>();
  for (const row of rows) {
    const key = candidateKeyFromRaw(row.manufacturer_raw, row.model_raw);
    if (!key) continue;
    const classification = classifyJetbuiltHistoryLine(row.manufacturer_raw, row.model_raw);
    let acc = map.get(key);
    if (!acc) {
      const parts = splitCandidateKey(key);
      acc = {
        candidateKey: key,
        normalizedManufacturer: parts.normalizedManufacturer,
        normalizedModel: parts.normalizedModel,
        manufacturerRawExamples: new Set(),
        modelRawExamples: new Set(),
        classification,
        lineItemOccurrences: 0,
        exactMatchedLineItemCount: 0,
        unmatchedLineItemCount: 0,
        validQuantityTotal: 0,
        rooms: new Set(),
        systems: new Set(),
        projects: new Set(),
        clients: new Set(),
        installProjects: new Set(),
        completedProjects: new Set(),
        deliveredProjects: new Set(),
        activeCommercialProjects: new Set(),
        stages: new Set(),
        projectStages: new Map(),
        firstSeen: null,
        lastSeen: null,
        exampleProjectIds: [],
        exampleRoomIds: [],
      };
      map.set(key, acc);
    }
    acc.lineItemOccurrences += 1;
    if (row.canonical_template_id) acc.exactMatchedLineItemCount += 1;
    else acc.unmatchedLineItemCount += 1;
    if (row.quantity_state === "valid" && row.quantity_numeric != null && row.quantity_numeric > 0) {
      acc.validQuantityTotal += row.quantity_numeric;
    }
    if (row.manufacturer_raw?.trim()) acc.manufacturerRawExamples.add(row.manufacturer_raw.trim());
    if (row.model_raw?.trim()) acc.modelRawExamples.add(row.model_raw.trim());
    if (row.room_id) acc.rooms.add(`${row.project_id}:${row.room_id}`);
    if (row.system_id) acc.systems.add(`${row.project_id}:${row.system_id}`);
    acc.projects.add(row.project_id);
    if (row.client_id) acc.clients.add(row.client_id);
    const stage = normalizeJetbuiltStage(row.stage_raw);
    if (stage) acc.stages.add(stage);
    acc.projectStages.set(row.project_id, row.stage_raw);
    if (isProjectInJetbuiltCohort(row.stage_raw, "install")) acc.installProjects.add(row.project_id);
    if (isProjectInJetbuiltCohort(row.stage_raw, "completed")) acc.completedProjects.add(row.project_id);
    if (isProjectInJetbuiltCohort(row.stage_raw, "delivered-or-installed")) acc.deliveredProjects.add(row.project_id);
    if (isProjectInJetbuiltCohort(row.stage_raw, "active-commercial")) acc.activeCommercialProjects.add(row.project_id);

    const seenCandidates = [
      row.source_created_at,
      row.source_updated_at,
      row.project_created_at,
      row.project_updated_at,
    ];
    for (const stamp of seenCandidates) {
      acc.firstSeen = minIso(acc.firstSeen, stamp);
      acc.lastSeen = maxIso(acc.lastSeen, stamp);
    }
    if (acc.exampleProjectIds.length < 5 && !acc.exampleProjectIds.includes(row.project_id)) {
      acc.exampleProjectIds.push(row.project_id);
    }
    if (row.room_id && acc.exampleRoomIds.length < 5) {
      const roomRef = `${row.project_id}:${row.room_id}`;
      if (!acc.exampleRoomIds.includes(roomRef)) acc.exampleRoomIds.push(roomRef);
    }
    // Keep first observed classification for the identity (rules are deterministic by identity).
    void nowMs;
  }
  return map;
}

function cohortProjectCounts(projectStages: Map<string, string | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cohort of JETBUILT_COHORTS) {
    let count = 0;
    for (const stage of projectStages.values()) {
      if (isProjectInJetbuiltCohort(stage, cohort)) count += 1;
    }
    counts[cohort] = count;
  }
  return counts;
}

function toPublicCandidate(acc: Accumulator, nowMs = Date.now()): JetbuiltDiscoveryCandidate {
  const ranking = scoreJetbuiltDiscoveryCandidate({
    deliveredOrInstalledProjectCount: acc.deliveredProjects.size,
    completedProjectCount: acc.completedProjects.size,
    installProjectCount: acc.installProjects.size,
    projectCount: acc.projects.size,
    roomCount: acc.rooms.size,
    lastSeen: acc.lastSeen,
    hasManufacturerAndModel: Boolean(acc.normalizedManufacturer && acc.normalizedModel),
  }, nowMs);

  return {
    candidateKey: acc.candidateKey,
    manufacturerRawExamples: [...acc.manufacturerRawExamples].sort((a, b) => a.localeCompare(b)).slice(0, 10),
    modelRawExamples: [...acc.modelRawExamples].sort((a, b) => a.localeCompare(b)).slice(0, 10),
    normalizedManufacturer: acc.normalizedManufacturer,
    normalizedModel: acc.normalizedModel,
    // True when any occurrence has an exact canonical link for this identity.
    exactCanonicalMatch: acc.exactMatchedLineItemCount > 0,
    exactMatchedLineItemCount: acc.exactMatchedLineItemCount,
    unmatchedLineItemCount: acc.unmatchedLineItemCount,
    classification: acc.classification,
    lineItemOccurrences: acc.lineItemOccurrences,
    validQuantityTotal: acc.validQuantityTotal,
    roomCount: acc.rooms.size,
    systemCount: acc.systems.size,
    projectCount: acc.projects.size,
    clientCount: acc.clients.size,
    firstSeen: acc.firstSeen,
    lastSeen: acc.lastSeen,
    rawStagesObserved: [...acc.stages].sort(),
    cohortCounts: cohortProjectCounts(acc.projectStages),
    installProjectCount: acc.installProjects.size,
    completedProjectCount: acc.completedProjects.size,
    deliveredOrInstalledProjectCount: acc.deliveredProjects.size,
    activeCommercialProjectCount: acc.activeCommercialProjects.size,
    priorityScore: ranking.priorityScore,
    priorityReasons: ranking.priorityReasons,
    rankingVersion: JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION,
    exampleProjectIds: [...acc.exampleProjectIds].sort(),
    exampleRoomIds: [...acc.exampleRoomIds].sort(),
  };
}

function compareCandidates(a: JetbuiltDiscoveryCandidate, b: JetbuiltDiscoveryCandidate): number {
  return b.priorityScore - a.priorityScore
    || b.deliveredOrInstalledProjectCount - a.deliveredOrInstalledProjectCount
    || b.completedProjectCount - a.completedProjectCount
    || b.installProjectCount - a.installProjectCount
    || b.projectCount - a.projectCount
    || b.roomCount - a.roomCount
    || String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? ""))
    || a.candidateKey.localeCompare(b.candidateKey);
}

function buildAllCandidates(db: DatabaseSync, input: JetbuiltDiscoveryScope = {}, nowMs = Date.now()): JetbuiltDiscoveryCandidate[] {
  const map = accumulateCandidates(loadLineRows(db, input), nowMs);
  return [...map.values()].map((acc) => toPublicCandidate(acc, nowMs)).sort(compareCandidates);
}

function applyCandidateFilters(candidates: JetbuiltDiscoveryCandidate[], input: JetbuiltCandidateListInput): JetbuiltDiscoveryCandidate[] {
  const excludeKnownNonSchematic = input.excludeKnownNonSchematic !== false;
  const exactCanonicalMatch = input.exactCanonicalMatch ?? false;
  const minProjects = Math.max(0, Math.trunc(input.minimumProjectCount ?? 1));
  const minRooms = Math.max(0, Math.trunc(input.minimumRoomCount ?? 0));
  const minDelivered = Math.max(0, Math.trunc(input.minimumDeliveredOrInstalledProjectCount ?? 0));
  const minScore = input.minimumPriorityScore == null ? null : Number(input.minimumPriorityScore);

  return candidates.filter((candidate) => {
    if (excludeKnownNonSchematic && candidate.classification.schematicRelevant === false) return false;
    // Default exactCanonicalMatch=false means "unmatched only" (no exact links).
    if (exactCanonicalMatch === false && candidate.exactCanonicalMatch) return false;
    if (exactCanonicalMatch === true && !candidate.exactCanonicalMatch) return false;
    if (candidate.projectCount < minProjects) return false;
    if (candidate.roomCount < minRooms) return false;
    if (candidate.deliveredOrInstalledProjectCount < minDelivered) return false;
    if (minScore != null && candidate.priorityScore < minScore) return false;
    return true;
  });
}

export function getJetbuiltLibraryCoverageSummary(
  db: DatabaseSync,
  input: JetbuiltDiscoveryScope = {},
  nowMs = Date.now(),
): Record<string, unknown> {
  const rows = loadLineRows(db, input);
  let exactMatched = 0;
  let unmatched = 0;
  let knownNonSchematic = 0;
  let eligibleUnmatched = 0;
  const eligibleKeys = new Set<string>();
  const highPriorityKeys = new Set<string>();
  const byManufacturer = new Map<string, number>();
  const byCohort: Record<string, { lineItems: number; unmatched: number; eligibleUnmatched: number }> = {};
  for (const cohort of JETBUILT_COHORTS) {
    byCohort[cohort] = { lineItems: 0, unmatched: 0, eligibleUnmatched: 0 };
  }

  for (const row of rows) {
    const classification = classifyJetbuiltHistoryLine(row.manufacturer_raw, row.model_raw);
    const matched = row.canonical_template_id != null;
    if (matched) exactMatched += 1;
    else unmatched += 1;
    if (classification.schematicRelevant === false) knownNonSchematic += 1;

    const maker = (row.manufacturer_raw ?? "").trim() || "(blank)";
    byManufacturer.set(maker, (byManufacturer.get(maker) ?? 0) + 1);

    for (const cohort of JETBUILT_COHORTS) {
      if (!isProjectInJetbuiltCohort(row.stage_raw, cohort)) continue;
      byCohort[cohort].lineItems += 1;
      if (!matched) byCohort[cohort].unmatched += 1;
    }

    const key = candidateKeyFromRaw(row.manufacturer_raw, row.model_raw);
    if (!matched && classification.schematicRelevant !== false && key) {
      eligibleUnmatched += 1;
      eligibleKeys.add(key);
      for (const cohort of JETBUILT_COHORTS) {
        if (isProjectInJetbuiltCohort(row.stage_raw, cohort)) byCohort[cohort].eligibleUnmatched += 1;
      }
    }
  }

  const candidates = applyCandidateFilters(buildAllCandidates(db, input, nowMs), {
    ...input,
    excludeKnownNonSchematic: true,
    exactCanonicalMatch: false,
    minimumProjectCount: 1,
  });
  for (const candidate of candidates) {
    if (candidate.priorityScore >= 40 || candidate.deliveredOrInstalledProjectCount >= 2) {
      highPriorityKeys.add(candidate.candidateKey);
    }
  }

  return {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    canonicalMatcherVersion: JETBUILT_HISTORY_MATCHER_VERSION,
    rankingVersion: JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION,
    totalHistoricalLineItems: rows.length,
    exactCanonicalMatches: exactMatched,
    unmatchedLines: unmatched,
    knownNonSchematicLines: knownNonSchematic,
    eligibleUnmatchedCandidateLines: eligibleUnmatched,
    distinctEligibleCandidateIdentities: eligibleKeys.size,
    highPriorityCandidateCount: highPriorityKeys.size,
    countsByCohort: byCohort,
    countsByManufacturer: [...byManufacturer.entries()]
      .map(([manufacturer, lineItemCount]) => ({ manufacturer, lineItemCount }))
      .sort((a, b) => b.lineItemCount - a.lineItemCount || a.manufacturer.localeCompare(b.manufacturer))
      .slice(0, 50),
  };
}

export function getJetbuiltLibraryCandidates(
  db: DatabaseSync,
  input: JetbuiltCandidateListInput = {},
  nowMs = Date.now(),
): Record<string, unknown> {
  const { limit, offset } = page(input);
  const filtered = applyCandidateFilters(buildAllCandidates(db, input, nowMs), input);
  const items = filtered.slice(offset, offset + limit);
  return {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    canonicalMatcherVersion: JETBUILT_HISTORY_MATCHER_VERSION,
    rankingVersion: JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION,
    rankingFormula: "12×min(delivered-or-installed projects,10) + 8×min(completed,10) + 6×min(install,10) + 4×min(projects,15) + 1.5×min(rooms,20) + recency(20/12/5) + identity(8); quantity is evidence only and does not dominate",
    filtersApplied: {
      cohort: input.cohort ?? "all",
      stage: input.stage ?? null,
      manufacturer: input.manufacturer ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      dateBasis: input.dateBasis ?? "created",
      minimumProjectCount: input.minimumProjectCount ?? 1,
      minimumRoomCount: input.minimumRoomCount ?? 0,
      minimumDeliveredOrInstalledProjectCount: input.minimumDeliveredOrInstalledProjectCount ?? 0,
      excludeKnownNonSchematic: input.excludeKnownNonSchematic !== false,
      exactCanonicalMatch: input.exactCanonicalMatch ?? false,
      minimumPriorityScore: input.minimumPriorityScore ?? null,
    },
    items,
    total: filtered.length,
    count: items.length,
    limit,
    offset,
    hasMore: offset + items.length < filtered.length,
  };
}

function manufacturerTokenMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  return Boolean(left && right && left === right);
}

/**
 * Bounded non-authoritative canonical correlation.
 * Exact match is authoritative only when normalized identity keys equal.
 * Other results are candidate review evidence only.
 */
export function correlateCandidateWithCanonicalLibrary(
  candidate: JetbuiltDiscoveryCandidate,
  canonicalDb: DatabaseSync | null | undefined,
): Record<string, unknown> {
  if (!canonicalDb) {
    return {
      exactCanonicalTemplates: [],
      possibleRelatedTemplates: [],
      manufacturerPresentInLibrary: null,
      note: "Canonical database was not provided; correlation skipped.",
      authority: "non-authoritative without canonical DB",
    };
  }
  const templates = listCurrentTemplates(canonicalDb);
  const exact = templates.filter((template) => {
    const key = normalizedLookupKey(template.manufacturer, template.modelNumber || template.label);
    return key === candidate.candidateKey;
  }).map((template) => ({
    templateId: template.id,
    manufacturer: template.manufacturer ?? null,
    model: template.modelNumber ?? null,
    label: template.label ?? null,
    category: template.category ?? null,
    deviceType: template.deviceType ?? null,
    relationship: "exact-normalized-identity",
    authority: "exact-canonical-identity-match",
  }));

  const sameManufacturer = templates.filter((template) =>
    manufacturerTokenMatch(template.manufacturer, candidate.normalizedManufacturer)
    && normalizedLookupKey(template.manufacturer, template.modelNumber || template.label) !== candidate.candidateKey);

  // Bounded model-token overlap evidence (not fuzzy authority).
  const modelToken = candidate.normalizedModel;
  const possibleRelated = sameManufacturer
    .map((template) => {
      const templateModel = normalizeToken(template.modelNumber || template.label);
      const reasons: string[] = ["same manufacturer (normalized)"];
      let score = 2;
      if (modelToken && templateModel && (templateModel.includes(modelToken) || modelToken.includes(templateModel))) {
        reasons.push("model token containment (review evidence only; not an exact match)");
        score += 3;
      }
      const prefix = modelToken.slice(0, Math.min(4, modelToken.length));
      if (prefix.length >= 3 && templateModel.startsWith(prefix)) {
        reasons.push(`shared model prefix "${prefix}" (review evidence only)`);
        score += 2;
      }
      return {
        templateId: template.id,
        manufacturer: template.manufacturer ?? null,
        model: template.modelNumber ?? null,
        label: template.label ?? null,
        category: template.category ?? null,
        deviceType: template.deviceType ?? null,
        relationship: "possible-related-template",
        authority: "candidate-review-evidence-only",
        relationshipReasons: reasons,
        reviewScore: score,
      };
    })
    .filter((row) => row.reviewScore > 2)
    .sort((a, b) => b.reviewScore - a.reviewScore || String(a.model).localeCompare(String(b.model)) || String(a.templateId).localeCompare(String(b.templateId)))
    .slice(0, 25);

  return {
    exactCanonicalTemplates: exact,
    possibleRelatedTemplates: possibleRelated,
    manufacturerPresentInLibrary: sameManufacturer.length > 0 || exact.length > 0,
    sameManufacturerTemplateCount: sameManufacturer.length + exact.length,
    authorityNote: "possibleRelatedTemplates are candidate review evidence only — not canonical matches and not fuzzy authority.",
  };
}

export function getJetbuiltLibraryCandidate(
  db: DatabaseSync,
  candidateKeyOrManufacturer: string,
  model?: string,
  options: { canonicalDb?: DatabaseSync | null; nowMs?: number } = {},
): Record<string, unknown> {
  const candidateKey = model
    ? candidateKeyFromRaw(candidateKeyOrManufacturer, model)
    : candidateKeyOrManufacturer.includes("::")
      ? candidateKeyOrManufacturer
      : null;
  if (!candidateKey) throw new Error("candidateKey or manufacturer+model is required");

  const candidates = buildAllCandidates(db, {}, options.nowMs);
  const candidate = candidates.find((row) => row.candidateKey === candidateKey);
  if (!candidate) throw new Error(`Jetbuilt library discovery candidate was not found: ${candidateKey}`);

  const correlation = correlateCandidateWithCanonicalLibrary(candidate, options.canonicalDb);
  return {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    canonicalMatcherVersion: JETBUILT_HISTORY_MATCHER_VERSION,
    rankingVersion: JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION,
    candidate,
    usage: getJetbuiltCandidateUsage(db, candidateKey),
    cooccurrence: getJetbuiltCandidateCooccurrence(db, { candidateKey, limit: 10 }),
    canonicalCorrelation: correlation,
    warnings: [
      "Historical frequency is triage evidence only and is not canonical device truth.",
      "possibleRelatedTemplates are non-authoritative review evidence.",
      "accepted Library Doctor proposals remain unapplied until an explicit human-controlled step.",
    ],
  };
}

export function getJetbuiltCandidateUsage(
  db: DatabaseSync,
  candidateKeyOrManufacturer: string,
  model?: string,
): Record<string, unknown> {
  const candidateKey = model
    ? candidateKeyFromRaw(candidateKeyOrManufacturer, model)
    : candidateKeyOrManufacturer.includes("::")
      ? candidateKeyOrManufacturer
      : null;
  if (!candidateKey) throw new Error("candidateKey or manufacturer+model is required");

  const rows = loadLineRows(db).filter((row) => candidateKeyFromRaw(row.manufacturer_raw, row.model_raw) === candidateKey);
  const byStage = new Map<string, { projects: Set<string>; rooms: Set<string>; lineItems: number; validQuantityTotal: number }>();
  const byYear = new Map<string, { projects: Set<string>; lineItems: number }>();
  for (const row of rows) {
    const stage = normalizeJetbuiltStage(row.stage_raw) ?? "unknown";
    let stageBucket = byStage.get(stage);
    if (!stageBucket) {
      stageBucket = { projects: new Set(), rooms: new Set(), lineItems: 0, validQuantityTotal: 0 };
      byStage.set(stage, stageBucket);
    }
    stageBucket.projects.add(row.project_id);
    if (row.room_id) stageBucket.rooms.add(`${row.project_id}:${row.room_id}`);
    stageBucket.lineItems += 1;
    if (row.quantity_state === "valid" && row.quantity_numeric != null && row.quantity_numeric > 0) {
      stageBucket.validQuantityTotal += row.quantity_numeric;
    }

    const stamp = row.project_created_at ?? row.source_created_at;
    const year = stamp ? String(stamp).slice(0, 4) : "unknown";
    let yearBucket = byYear.get(year);
    if (!yearBucket) {
      yearBucket = { projects: new Set(), lineItems: 0 };
      byYear.set(year, yearBucket);
    }
    yearBucket.projects.add(row.project_id);
    yearBucket.lineItems += 1;
  }

  const cohortCounts: Record<string, number> = {};
  for (const cohort of JETBUILT_COHORTS) {
    const projects = new Set(rows.filter((row) => isProjectInJetbuiltCohort(row.stage_raw, cohort)).map((row) => row.project_id));
    cohortCounts[cohort] = projects.size;
  }

  return {
    candidateKey,
    lineItemOccurrences: rows.length,
    projectCount: new Set(rows.map((row) => row.project_id)).size,
    roomCount: new Set(rows.filter((row) => row.room_id).map((row) => `${row.project_id}:${row.room_id}`)).size,
    systemCount: new Set(rows.filter((row) => row.system_id).map((row) => `${row.project_id}:${row.system_id}`)).size,
    clientCount: new Set(rows.map((row) => row.client_id).filter((id): id is string => id != null)).size,
    byStage: [...byStage.entries()].map(([stage, bucket]) => ({
      stage,
      projectCount: bucket.projects.size,
      roomCount: bucket.rooms.size,
      lineItemOccurrences: bucket.lineItems,
      validQuantityTotal: bucket.validQuantityTotal,
    })).sort((a, b) => a.stage.localeCompare(b.stage)),
    byYear: [...byYear.entries()].map(([year, bucket]) => ({
      year,
      projectCount: bucket.projects.size,
      lineItemOccurrences: bucket.lineItems,
    })).sort((a, b) => a.year.localeCompare(b.year)),
    cohortProjectCounts: cohortCounts,
    exampleProjectIds: [...new Set(rows.map((row) => row.project_id))].sort().slice(0, 10),
  };
}

export interface CandidateCooccurrenceInput extends JetbuiltDiscoveryScope {
  candidateKey?: string;
  manufacturer?: string;
  model?: string;
  limit?: number;
  offset?: number;
  minimumRoomCount?: number;
}

export function getJetbuiltCandidateCooccurrence(
  db: DatabaseSync,
  input: CandidateCooccurrenceInput,
): Record<string, unknown> {
  const candidateKey = input.candidateKey
    ?? (input.manufacturer && input.model ? candidateKeyFromRaw(input.manufacturer, input.model) : null);
  if (!candidateKey) throw new Error("candidateKey or manufacturer+model is required");

  const rows = loadLineRows(db, input);
  const targetRooms = new Set<string>();
  for (const row of rows) {
    if (!row.room_id) continue;
    if (candidateKeyFromRaw(row.manufacturer_raw, row.model_raw) === candidateKey) {
      targetRooms.add(`${row.project_id}:${row.room_id}`);
    }
  }

  const groups = new Map<string, {
    manufacturerRaw: string | null;
    modelRaw: string | null;
    candidateKey: string;
    lineItemOccurrences: number;
    rooms: Set<string>;
    projects: Set<string>;
    firstSeen: string | null;
    lastSeen: string | null;
  }>();

  for (const row of rows) {
    if (!row.room_id) continue;
    const roomKey = `${row.project_id}:${row.room_id}`;
    if (!targetRooms.has(roomKey)) continue;
    const otherKey = candidateKeyFromRaw(row.manufacturer_raw, row.model_raw);
    if (!otherKey || otherKey === candidateKey) continue;
    let group = groups.get(otherKey);
    if (!group) {
      group = {
        manufacturerRaw: row.manufacturer_raw,
        modelRaw: row.model_raw,
        candidateKey: otherKey,
        lineItemOccurrences: 0,
        rooms: new Set(),
        projects: new Set(),
        firstSeen: null,
        lastSeen: null,
      };
      groups.set(otherKey, group);
    }
    group.lineItemOccurrences += 1;
    group.rooms.add(roomKey);
    group.projects.add(row.project_id);
    const stamp = row.source_created_at ?? row.project_created_at;
    group.firstSeen = minIso(group.firstSeen, stamp);
    group.lastSeen = maxIso(group.lastSeen, stamp);
  }

  const minimumRoomCount = Math.max(1, Math.trunc(input.minimumRoomCount ?? 1));
  const sorted = [...groups.values()]
    .filter((group) => group.rooms.size >= minimumRoomCount)
    .map((group) => ({
      candidateKey: group.candidateKey,
      manufacturer: group.manufacturerRaw,
      model: group.modelRaw,
      lineItemOccurrences: group.lineItemOccurrences,
      roomCount: group.rooms.size,
      projectCount: group.projects.size,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      classification: classifyJetbuiltHistoryLine(group.manufacturerRaw, group.modelRaw),
    }))
    .sort((a, b) => b.roomCount - a.roomCount
      || b.lineItemOccurrences - a.lineItemOccurrences
      || a.candidateKey.localeCompare(b.candidateKey));

  const { limit, offset } = page(input);
  const items = sorted.slice(offset, offset + limit);
  return {
    targetCandidateKey: candidateKey,
    targetRoomCount: targetRooms.size,
    metricsNote: "lineItemOccurrences, roomCount, and projectCount are distinct metrics and are not interchangeable.",
    items,
    total: sorted.length,
    count: items.length,
    limit,
    offset,
    hasMore: offset + items.length < sorted.length,
  };
}

/** Test helper: expose scoring weights documentation. */
export function getJetbuiltLibraryDiscoveryRankingSemantics(): Record<string, unknown> {
  return {
    rankingVersion: JETBUILT_LIBRARY_DISCOVERY_RANKING_VERSION,
    formula: "12×min(delivered-or-installed projects,10) + 8×min(completed,10) + 6×min(install,10) + 4×min(projects,15) + 1.5×min(rooms,20) + recency(20/12/5) + identity(8)",
    quantityPolicy: "validQuantityTotal is returned as evidence only and does not contribute to priorityScore",
    notTruth: true,
  };
}

export type { DeviceTemplate };
