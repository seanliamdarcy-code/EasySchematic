import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import type { ProductBundleDefinition } from "../../src/quoteImportTypes.js";
import { listCurrentTemplates } from "./deviceStore.js";
import { classifyJetbuiltHistoryLine, JETBUILT_SCHEMATIC_RELEVANCE_VERSION } from "./jetbuiltHistoryLineClassification.js";
import { getJetbuiltCohortSemantics } from "./jetbuiltHistoryCohorts.js";
import { JETBUILT_HISTORY_MATCHER_VERSION } from "./jetbuiltHistoryStore.js";
import { syncJetbuiltHistory } from "./jetbuiltHistorySync.js";
import { listLibraryDoctorProposals } from "./libraryDoctorStore.js";
import {
  buildLibraryIdentityIndex,
  normalizedLookupKey,
  resolveLibraryIdentity,
  type LibraryIdentityIndex,
} from "./libraryIdentity.js";
import { listProductBundles, resolveProductBundle } from "./productBundleStore.js";

export const JETBUILT_PROJECT_LIBRARY_GAP_ANALYSIS_VERSION = "jetbuilt-project-library-gap-v6";
export const JETBUILT_PROJECT_LIBRARY_GAP_PROPOSAL_STATE_VERSION = "jetbuilt-project-gap-proposal-state-v1";
const MAX_PROJECT_LINE_ITEMS = 5_000;

export type JetbuiltProjectGapStatus =
  | "exact-canonical-match"
  | "known-non-schematic"
  | "known-product-bundle"
  | "already-proposed"
  | "unmatched-hardware-candidate"
  | "possible-identity-variant"
  | "needs-manual-review"
  | "insufficient-identity";

export interface ProjectGapProposalIdentity {
  id: string;
  manufacturer: string | null;
  modelNumber: string | null;
  status: string;
  generationKey: string | null;
  identityAliases: string[];
}

export interface ProjectGapCandidateResult {
  runKey: string;
  candidateKey: string;
  projectNumber: string;
  status: string;
  validationIssues: string[];
  proposalId: string | null;
  updatedAt: string;
}

export interface ProjectGapProposalState {
  proposals: ProjectGapProposalIdentity[];
  candidateResults: ProjectGapCandidateResult[];
  source: "local" | "proposal-service";
  requestCount: number;
}

export interface ProjectGapAcquisitionOptions {
  apiKey: string;
  baseUrl?: string;
  indexPath: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ProjectRow {
  jetbuilt_id: string;
  client_id: string | null;
  custom_id_raw: string | null;
  name_raw: string | null;
  stage_raw: string | null;
  active: number | null;
  version_raw: string | null;
  original_version_id: string | null;
}

export interface ProjectGapRoom {
  id: string;
  name: string | null;
  quantity: string | null;
  active: number | null;
}

export interface ProjectGapSystem {
  id: string;
  name: string | null;
}

interface LineRow {
  jetbuilt_id: string;
  project_id: string;
  room_id: string | null;
  system_id: string | null;
  room_name: string | null;
  system_name: string | null;
  manufacturer_raw: string | null;
  model_raw: string | null;
  product_id: string | null;
  part_number_raw: string | null;
  description_raw: string | null;
  quantity_raw: string | null;
  quantity_numeric: number | null;
  quantity_state: string;
  kind_raw: string | null;
  hidden: number | null;
  option_id: string | null;
  replacement_ids_json: string;
  canonical_template_id: string | null;
}

interface HistoryUsageRow {
  project_id: string;
  room_id: string | null;
  system_id: string | null;
  manufacturer_raw: string | null;
  model_raw: string | null;
  quantity_numeric: number | null;
  quantity_state: string;
}

export class JetbuiltProjectGapError extends Error {
  constructor(public readonly code: "project-not-found" | "project-not-found-in-cached-index" | "ambiguous-project" | "project-too-large" | "acquisition-unavailable", message: string) {
    super(message);
    this.name = "JetbuiltProjectGapError";
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function projectNumberKey(value: string): string {
  return normalize(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function proposalAliases(value: unknown): string[] {
  const root = parseObject(value);
  const metadata = parseObject(root?.proposalMetadata);
  return Array.isArray(metadata?.identityAliases)
    ? metadata.identityAliases.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

export function listProjectGapProposalIdentities(db: DatabaseSync): ProjectGapProposalIdentity[] {
  return listLibraryDoctorProposals(db, { proposalType: "new-template" }).map((proposal) => ({
    id: proposal.id,
    manufacturer: proposal.manufacturer,
    modelNumber: proposal.modelNumber,
    status: proposal.status,
    generationKey: proposal.generationKey,
    identityAliases: proposalAliases(proposal.proposedValue),
  }));
}

export function listProjectGapCandidateResults(db: DatabaseSync, projectNumber?: string): ProjectGapCandidateResult[] {
  const where = projectNumber ? "WHERE lower(project_number) = lower(?)" : "";
  const values = projectNumber ? [projectNumber.trim()] : [];
  return (db.prepare(`SELECT run_key, candidate_key, project_number, status, validation_issues_json, proposal_id, updated_at
    FROM jetbuilt_project_gap_candidate_results ${where} ORDER BY updated_at DESC, candidate_key`).all(...values) as Array<Record<string, unknown>>)
    .map((row) => ({
      runKey: String(row.run_key),
      candidateKey: String(row.candidate_key),
      projectNumber: String(row.project_number),
      status: String(row.status),
      validationIssues: JSON.parse(String(row.validation_issues_json)) as string[],
      proposalId: row.proposal_id == null ? null : String(row.proposal_id),
      updatedAt: String(row.updated_at),
    }));
}

function localProposalState(db: DatabaseSync, projectNumber: string): ProjectGapProposalState {
  return {
    proposals: listProjectGapProposalIdentities(db),
    candidateResults: listProjectGapCandidateResults(db, projectNumber),
    source: "local",
    requestCount: 0,
  };
}

function findProject(db: DatabaseSync, requested: string): ProjectRow {
  const key = projectNumberKey(requested);
  const rows = db.prepare(`SELECT jetbuilt_id, client_id, custom_id_raw, name_raw, stage_raw, active, version_raw, original_version_id
    FROM projects
    WHERE lower(replace(replace(trim(coalesce(custom_id_raw, '')), '-', ''), ' ', '')) = ?
       OR lower(trim(jetbuilt_id)) = lower(trim(?))
    ORDER BY jetbuilt_id`).all(key, requested) as unknown as ProjectRow[];
  if (rows.length === 0) throw new JetbuiltProjectGapError("project-not-found", `Project ${requested} is not present in the local Jetbuilt history database`);
  if (rows.length > 1) throw new JetbuiltProjectGapError("ambiguous-project", `Project lookup for ${requested} matched ${rows.length} records`);
  return rows[0];
}

function canonicalSnapshotIdentity(templates: DeviceTemplate[]): string {
  return hash(JSON.stringify(templates.map((template) => ({
    id: template.id ?? null,
    version: template.version ?? null,
    identity: normalizedLookupKey(template.manufacturer, template.modelNumber || template.label),
    identityAliases: (template.identityAliases ?? []).map(normalize).sort(),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)))));
}

/** Deterministic snapshot of commercial product-bundle catalogue (import expansion source). */
function productBundleSnapshotIdentity(bundles: readonly ProductBundleDefinition[]): string {
  return hash(JSON.stringify(bundles.map((bundle) => ({
    id: bundle.id,
    manufacturer: bundle.manufacturer,
    sku: bundle.sku,
    aliases: [...(bundle.aliases ?? [])].map(normalize).sort(),
    source: bundle.source,
    components: bundle.components.map((component) => ({
      manufacturer: component.manufacturer,
      model: component.model,
      quantityPerBundle: component.quantityPerBundle,
      schematicRelevant: component.schematicRelevant === true,
    })).sort((a, b) => `${a.manufacturer}::${a.model}`.localeCompare(`${b.manufacturer}::${b.model}`)),
  })).sort((a, b) => a.id.localeCompare(b.id) || `${a.manufacturer}::${a.sku}`.localeCompare(`${b.manufacturer}::${b.sku}`))));
}

function productBundleEvidence(
  bundle: ProductBundleDefinition,
  identityIndex: LibraryIdentityIndex,
) {
  const components = bundle.components.map((component) => {
    const resolution = resolveLibraryIdentity(identityIndex, component.manufacturer, component.model);
    return {
      manufacturer: component.manufacturer,
      model: component.model,
      quantityPerBundle: component.quantityPerBundle,
      schematicRelevant: component.schematicRelevant === true,
      libraryResolution: resolution.kind,
      libraryTemplates: resolution.kind === "unique"
        ? templateRefs([resolution.template])
        : resolution.kind === "ambiguous"
          ? templateRefs(resolution.templates)
          : [],
    };
  });
  const schematicComponents = components.filter((component) => component.schematicRelevant);
  return {
    id: bundle.id,
    manufacturer: bundle.manufacturer,
    sku: bundle.sku,
    label: bundle.label,
    source: bundle.source,
    aliases: [...(bundle.aliases ?? [])],
    components,
    schematicComponentCount: schematicComponents.length,
    schematicComponentsResolvedUnique: schematicComponents.filter((component) => component.libraryResolution === "unique").length,
    schematicComponentsMissingFromLibrary: schematicComponents.filter((component) => component.libraryResolution === "none").length,
  };
}

function projectSourceFingerprint(project: ProjectRow, rooms: ProjectGapRoom[], systems: ProjectGapSystem[], lines: LineRow[]): string {
  return hash(JSON.stringify({
    project: {
      id: project.jetbuilt_id,
      clientId: project.client_id,
      customId: project.custom_id_raw,
      name: project.name_raw,
      stage: project.stage_raw,
      active: project.active,
      version: project.version_raw,
      originalVersionId: project.original_version_id,
    },
    rooms: rooms.map((room) => ({ id: room.id, name: room.name, quantity: room.quantity, active: room.active })),
    systems: systems.map((system) => ({ id: system.id, name: system.name })),
    lineItems: lines.map((line) => ({
      id: line.jetbuilt_id,
      projectId: line.project_id,
      roomId: line.room_id,
      systemId: line.system_id,
      productId: line.product_id,
      manufacturer: line.manufacturer_raw,
      model: line.model_raw,
      partNumber: line.part_number_raw,
      description: line.description_raw,
      quantity: line.quantity_raw,
      quantityNumeric: line.quantity_numeric,
      quantityState: line.quantity_state,
      kind: line.kind_raw,
      hidden: line.hidden,
      optionId: line.option_id,
      replacementIds: line.replacement_ids_json,
    })),
  }));
}

function proposalStateIdentity(state: ProjectGapProposalState): string {
  return hash(JSON.stringify({
    version: JETBUILT_PROJECT_LIBRARY_GAP_PROPOSAL_STATE_VERSION,
    proposals: state.proposals.map((proposal) => ({
      id: proposal.id,
      manufacturer: proposal.manufacturer,
      modelNumber: proposal.modelNumber,
      status: proposal.status,
      generationKey: proposal.generationKey,
      identityAliases: [...proposal.identityAliases].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    candidateResults: state.candidateResults.map((result) => ({
      runKey: result.runKey,
      candidateKey: result.candidateKey,
      projectNumber: result.projectNumber,
      status: result.status,
      validationIssues: [...result.validationIssues].sort(),
      proposalId: result.proposalId,
    })).sort((a, b) => `${a.runKey}:${a.candidateKey}`.localeCompare(`${b.runKey}:${b.candidateKey}`)),
  }));
}

function templateRefs(templates: DeviceTemplate[]) {
  return templates.map(({ id, manufacturer, modelNumber, label }) => ({ id: id ?? null, manufacturer: manufacturer ?? null, modelNumber: modelNumber ?? null, label }));
}

function proposalMatches(candidateKey: string, manufacturer: string, model: string, proposals: ProjectGapProposalIdentity[]) {
  const normalizedModel = normalize(model);
  const normalizedManufacturer = normalize(manufacturer);
  const defaultGenerationKey = `new-template:${hash(candidateKey)}`;
  const jetbuiltGenerationKey = `jetbuilt:${candidateKey}:new-template:v1`;
  return proposals.filter((proposal) => {
    if (proposal.generationKey === defaultGenerationKey || proposal.generationKey === jetbuiltGenerationKey) return true;
    if (normalize(proposal.manufacturer) !== normalizedManufacturer) return false;
    return normalize(proposal.modelNumber) === normalizedModel || proposal.identityAliases.some((alias) => normalize(alias) === normalizedModel);
  });
}

function historicalUsage(rows: HistoryUsageRow[], candidateKeys: Set<string>, projectId: string) {
  const map = new Map<string, { lineItems: number; quantity: number; projects: Set<string>; rooms: Set<string>; systems: Set<string> }>();
  for (const row of rows) {
    if (row.project_id === projectId) continue;
    const key = normalizedLookupKey(row.manufacturer_raw, row.model_raw);
    if (!key || !candidateKeys.has(key)) continue;
    const item = map.get(key) ?? { lineItems: 0, quantity: 0, projects: new Set(), rooms: new Set(), systems: new Set() };
    item.lineItems += 1;
    if (row.quantity_state === "valid" && row.quantity_numeric != null && row.quantity_numeric > 0) item.quantity += row.quantity_numeric;
    item.projects.add(row.project_id);
    if (row.room_id) item.rooms.add(`${row.project_id}:${row.room_id}`);
    if (row.system_id) item.systems.add(`${row.project_id}:${row.system_id}`);
    map.set(key, item);
  }
  return map;
}

export function getJetbuiltProjectLibraryGapAnalysis(
  historyDb: DatabaseSync,
  canonicalDb: DatabaseSync,
  projectNumber: string,
  proposalState?: ProjectGapProposalState,
) {
  const requested = projectNumber.trim();
  if (!requested) throw new JetbuiltProjectGapError("project-not-found", "projectNumber is required");
  const project = findProject(historyDb, requested);
  const rooms = historyDb.prepare("SELECT jetbuilt_id id, name_raw name, quantity_raw quantity, active FROM rooms WHERE project_id = ? ORDER BY jetbuilt_id").all(project.jetbuilt_id) as unknown as ProjectGapRoom[];
  const systems = historyDb.prepare("SELECT jetbuilt_id id, name_raw name FROM systems WHERE project_id = ? ORDER BY jetbuilt_id").all(project.jetbuilt_id) as unknown as ProjectGapSystem[];
  const lines = historyDb.prepare(`SELECT l.jetbuilt_id, l.project_id, l.room_id, l.system_id, r.name_raw room_name, s.name_raw system_name,
    l.product_id, l.manufacturer_raw, l.model_raw, l.part_number_raw, l.description_raw, l.quantity_raw, l.quantity_numeric,
    l.quantity_state, l.kind_raw, l.hidden, l.option_id, l.replacement_ids_json, c.canonical_template_id
    FROM line_items l
    LEFT JOIN rooms r ON r.project_id=l.project_id AND r.jetbuilt_id=l.room_id
    LEFT JOIN systems s ON s.project_id=l.project_id AND s.jetbuilt_id=l.system_id
    LEFT JOIN canonical_template_links c ON c.project_id=l.project_id AND c.line_item_id=l.jetbuilt_id
    WHERE l.project_id=? ORDER BY l.jetbuilt_id`).all(project.jetbuilt_id) as unknown as LineRow[];
  if (lines.length > MAX_PROJECT_LINE_ITEMS) throw new JetbuiltProjectGapError("project-too-large", `Project has ${lines.length} line items; maximum bounded analysis is ${MAX_PROJECT_LINE_ITEMS}`);

  const templates = listCurrentTemplates(canonicalDb);
  const productBundles = listProductBundles(canonicalDb);
  const activeTemplateIds = new Set(templates.map((template) => template.id).filter((id): id is string => Boolean(id)));
  const identityIndex = buildLibraryIdentityIndex(templates);
  const snapshotIdentity = canonicalSnapshotIdentity(templates);
  const bundleSnapshotIdentity = productBundleSnapshotIdentity(productBundles);
  const sourceFingerprint = projectSourceFingerprint(project, rooms, systems, lines);
  const normalizedProjectNumber = project.custom_id_raw?.trim() || requested;
  const runKey = `jetbuilt-project-gap:${hash(JSON.stringify({
    projectSourceFingerprint: sourceFingerprint,
    analysisVersion: JETBUILT_PROJECT_LIBRARY_GAP_ANALYSIS_VERSION,
    canonicalSnapshotIdentity: snapshotIdentity,
    productBundleSnapshotIdentity: bundleSnapshotIdentity,
  }))}`;
  const state = proposalState ?? localProposalState(canonicalDb, normalizedProjectNumber);
  const stateIdentity = proposalStateIdentity(state);
  const resultByCandidate = new Map(state.candidateResults.filter((result) => result.runKey === runKey).map((result) => [result.candidateKey, result]));

  const grouped = new Map<string, { manufacturer: string; model: string; manufacturerExamples: Set<string>; modelExamples: Set<string>; lines: LineRow[] }>();
  const insufficientIdentityLines: Array<{ lineItemId: string; manufacturer: string | null; model: string | null; status: "insufficient-identity" }> = [];
  for (const line of lines) {
    const key = normalizedLookupKey(line.manufacturer_raw, line.model_raw);
    if (!key || !key.includes("::")) {
      insufficientIdentityLines.push({ lineItemId: line.jetbuilt_id, manufacturer: line.manufacturer_raw, model: line.model_raw, status: "insufficient-identity" });
      continue;
    }
    const item = grouped.get(key) ?? {
      manufacturer: line.manufacturer_raw!.trim(), model: line.model_raw!.trim(), manufacturerExamples: new Set(), modelExamples: new Set(), lines: [],
    };
    item.manufacturerExamples.add(line.manufacturer_raw!.trim());
    item.modelExamples.add(line.model_raw!.trim());
    item.lines.push(line);
    grouped.set(key, item);
  }

  const allHistoryRows = historyDb.prepare(`SELECT project_id, room_id, system_id, manufacturer_raw, model_raw, quantity_numeric, quantity_state
    FROM line_items ORDER BY project_id, jetbuilt_id`).all() as unknown as HistoryUsageRow[];
  const outsideUsage = historicalUsage(allHistoryRows, new Set(grouped.keys()), project.jetbuilt_id);
  const candidates = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([candidateKey, identity]) => {
    const classification = classifyJetbuiltHistoryLine(identity.manufacturer, identity.model);
    const resolution = resolveLibraryIdentity(identityIndex, identity.manufacturer, identity.model);
    const uniqueTemplates = resolution.kind === "unique" ? [resolution.template] : [];
    const ambiguousTemplates = resolution.kind === "ambiguous" ? resolution.templates : [];
    const productBundle = resolveProductBundle(canonicalDb, identity.manufacturer, identity.model);
    const bundleEvidence = productBundle ? productBundleEvidence(productBundle, identityIndex) : null;
    const existingProposals = proposalMatches(candidateKey, identity.manufacturer, identity.model, state.proposals);
    const previousResult = resultByCandidate.get(candidateKey);
    let status: JetbuiltProjectGapStatus = "unmatched-hardware-candidate";
    // Priority: commercial product-bundle expansion beats single-device identity for the same SKU
    // (import expands to placeable components; never treat a known commercial bundle as one device).
    // Then: device identity > non-schematic > proposals > review.
    if (productBundle) status = "known-product-bundle";
    else if (resolution.kind === "unique") status = "exact-canonical-match";
    else if (resolution.kind === "ambiguous") status = "possible-identity-variant";
    else if (classification.schematicRelevant === false) status = "known-non-schematic";
    else if (existingProposals.length) status = "already-proposed";
    else if (previousResult?.status === "validation-failed") status = "needs-manual-review";
    const usage = outsideUsage.get(candidateKey);
    const projectRooms = new Map(identity.lines.filter((line) => line.room_id).map((line) => [line.room_id!, line.room_name]));
    const projectSystems = new Map(identity.lines.filter((line) => line.system_id).map((line) => [line.system_id!, line.system_name]));
    const storedHistoryCanonicalTemplateIds = [...new Set(identity.lines.map((line) => line.canonical_template_id).filter((id): id is string => Boolean(id)))].sort();
    return {
      candidateKey,
      status,
      manufacturer: identity.manufacturer,
      model: identity.model,
      manufacturerRawExamples: [...identity.manufacturerExamples].sort(),
      modelRawExamples: [...identity.modelExamples].sort(),
      classification,
      projectUsage: {
        lineItemCount: identity.lines.length,
        validQuantityTotal: identity.lines.reduce((sum, line) => sum + (line.quantity_state === "valid" && line.quantity_numeric != null && line.quantity_numeric > 0 ? line.quantity_numeric : 0), 0),
        rooms: [...projectRooms].map(([id, name]) => ({ id, name })),
        systems: [...projectSystems].map(([id, name]) => ({ id, name })),
      },
      historicalUsageOutsideProject: {
        lineItemCount: usage?.lineItems ?? 0,
        validQuantityTotal: usage?.quantity ?? 0,
        projectCount: usage?.projects.size ?? 0,
        roomCount: usage?.rooms.size ?? 0,
        systemCount: usage?.systems.size ?? 0,
      },
      currentCanonicalCollisionEvidence: templateRefs(uniqueTemplates),
      possibleIdentityVariantEvidence: templateRefs(ambiguousTemplates),
      productBundleEvidence: bundleEvidence,
      storedHistoryCanonicalTemplateIds,
      inactiveOrMissingStoredCanonicalTemplateIds: storedHistoryCanonicalTemplateIds.filter((id) => !activeTemplateIds.has(id)),
      existingProposals,
      previousResult: previousResult ?? null,
      generationKey: `new-template:${hash(candidateKey)}`,
      projectGapContext: {
        runKey,
        candidateKey,
        projectNumber: normalizedProjectNumber,
        analysisVersion: JETBUILT_PROJECT_LIBRARY_GAP_ANALYSIS_VERSION,
        projectSourceFingerprint: sourceFingerprint,
        canonicalSnapshotIdentity: snapshotIdentity,
        productBundleSnapshotIdentity: bundleSnapshotIdentity,
      },
    };
  });

  const count = (status: JetbuiltProjectGapStatus) => candidates.filter((candidate) => candidate.status === status).length;
  return {
    success: true,
    readOnlyExternalSystems: true,
    analysisVersion: JETBUILT_PROJECT_LIBRARY_GAP_ANALYSIS_VERSION,
    runKey,
    projectSourceFingerprint: sourceFingerprint,
    canonicalSnapshotIdentity: snapshotIdentity,
    productBundleSnapshotIdentity: bundleSnapshotIdentity,
    proposalStateVersion: JETBUILT_PROJECT_LIBRARY_GAP_PROPOSAL_STATE_VERSION,
    proposalStateIdentity: stateIdentity,
    proposalStateSource: state.source,
    proposalStateSemantics: "live-overlay-excluded-from-run-key",
    requestedProjectNumber: requested,
    matchedProjectId: project.jetbuilt_id,
    projectNumber: normalizedProjectNumber,
    projectName: project.name_raw,
    stage: project.stage_raw,
    active: project.active === null ? null : project.active === 1,
    cohortSemantics: getJetbuiltCohortSemantics(),
    lineItemCount: lines.length,
    distinctCandidateIdentityCount: grouped.size,
    rooms,
    systems,
    candidates,
    insufficientIdentityLines,
    exactCanonicalMatches: candidates.filter((candidate) => candidate.status === "exact-canonical-match"),
    knownNonSchematicExclusions: candidates.filter((candidate) => candidate.status === "known-non-schematic"),
    knownProductBundles: candidates.filter((candidate) => candidate.status === "known-product-bundle"),
    existingPendingProposalMatches: candidates.filter((candidate) => candidate.status === "already-proposed"),
    unmatchedEligibleCandidates: candidates.filter((candidate) => candidate.status === "unmatched-hardware-candidate"),
    possibleIdentityVariants: candidates.filter((candidate) => candidate.status === "possible-identity-variant"),
    manualReviewCandidates: candidates.filter((candidate) => candidate.status === "needs-manual-review"),
    summary: {
      lineItems: lines.length,
      distinctIdentities: grouped.size,
      exactCanonicalMatches: count("exact-canonical-match"),
      knownNonSchematic: count("known-non-schematic"),
      knownProductBundles: count("known-product-bundle"),
      alreadyProposed: count("already-proposed"),
      possibleIdentityVariants: count("possible-identity-variant"),
      unmatchedEligible: count("unmatched-hardware-candidate"),
      needsManualReview: count("needs-manual-review") + insufficientIdentityLines.length,
    },
    queryCounts: {
      historyDatabase: 5,
      // listCurrentTemplates + listProductBundles + optional proposal overlay tables
      canonicalDatabase: proposalState ? 2 : 4,
      proposalServiceRequests: state.requestCount,
      jetbuiltGetRequests: 0,
      jetbuiltWriteRequests: 0,
    },
    versions: {
      schematicRelevance: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
      canonicalMatcher: JETBUILT_HISTORY_MATCHER_VERSION,
    },
    warnings: [
      "Unmatched is triage evidence, not proof that a canonical device is missing.",
      "Exact matches use canonical model/label, reviewed identityAliases, or reviewed manufacturer equivalence groups only; searchTerms never create exact identity hits.",
      "Ambiguous identity collisions (multiple distinct templates for one key) are reported as possible-identity-variant and never auto-selected.",
      "Known product bundles expand to schematic-relevant components on import; the commercial SKU is not itself a placeable library device.",
      "Product-bundle component libraryResolution reports which expanded components already resolve in the library; missing components remain fill work.",
      "Stored history template IDs absent from the active canonical library are reported separately and never treated as current matches.",
      "Proposal creation still requires official research and all quality gates.",
    ],
  };
}

function cachedProjectId(indexPath: string, requestedProjectNumber: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    throw new JetbuiltProjectGapError("acquisition-unavailable", "The cached Jetbuilt project index is unavailable");
  }
  const projects = parseObject(parsed)?.projects;
  if (!Array.isArray(projects)) throw new JetbuiltProjectGapError("acquisition-unavailable", "The cached Jetbuilt project index is invalid");
  const key = projectNumberKey(requestedProjectNumber);
  const matches = projects.filter((entry) => {
    const project = parseObject(entry);
    return project && (projectNumberKey(String(project.customId ?? "")) === key || String(project.id ?? "").trim().toLowerCase() === requestedProjectNumber.trim().toLowerCase());
  });
  if (matches.length === 0) throw new JetbuiltProjectGapError("project-not-found-in-cached-index", `Project ${requestedProjectNumber} was not found in the bounded cached Jetbuilt index; absence from Jetbuilt is not established`);
  if (matches.length > 1) throw new JetbuiltProjectGapError("ambiguous-project", `Project ${requestedProjectNumber} matched ${matches.length} cached Jetbuilt projects`);
  const id = String(parseObject(matches[0])?.id ?? "").trim();
  if (!id) throw new JetbuiltProjectGapError("acquisition-unavailable", "The cached Jetbuilt project has no ID");
  return id;
}

export async function getJetbuiltProjectLibraryGapAnalysisWithAcquisition(
  historyDb: DatabaseSync,
  canonicalDb: DatabaseSync,
  projectNumber: string,
  proposalState: ProjectGapProposalState | undefined,
  acquisition: ProjectGapAcquisitionOptions | null,
) {
  try {
    return getJetbuiltProjectLibraryGapAnalysis(historyDb, canonicalDb, projectNumber, proposalState);
  } catch (error) {
    if (!(error instanceof JetbuiltProjectGapError) || error.code !== "project-not-found") throw error;
    if (!acquisition?.apiKey.trim()) throw new JetbuiltProjectGapError("acquisition-unavailable", `${error.message}; on-demand acquisition has no Jetbuilt API credential`);
    const projectId = cachedProjectId(acquisition.indexPath, projectNumber);
    const sync = await syncJetbuiltHistory(historyDb, { projectIds: [projectId], maxProjectCount: 1 }, {
      apiKey: acquisition.apiKey,
      baseUrl: acquisition.baseUrl,
      indexPath: acquisition.indexPath,
      refreshMs: 0,
      fetchImpl: acquisition.fetchImpl,
      sleepImpl: acquisition.sleepImpl,
    });
    const requestCount = Number((historyDb.prepare("SELECT request_count count FROM sync_runs WHERE id=?").get(sync.syncRunId) as { count: number }).count);
    const result = getJetbuiltProjectLibraryGapAnalysis(historyDb, canonicalDb, projectNumber, proposalState);
    return {
      ...result,
      acquisition: { performed: true, source: "exact-cached-project-index", projectCount: 1, syncRunId: sync.syncRunId, jetbuiltGetRequests: requestCount, jetbuiltWriteRequests: 0 },
      queryCounts: { ...result.queryCounts, historyDatabase: result.queryCounts.historyDatabase + 1, jetbuiltGetRequests: requestCount },
    };
  }
}
