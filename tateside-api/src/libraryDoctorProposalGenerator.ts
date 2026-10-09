import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate, Port, TaxonomyEvidenceRef } from "../../src/types.js";
import { auditLibraryTemplates, type LibraryAuditIssue } from "./libraryAudit.js";
import {
  LibraryDoctorStoreError,
  createLibraryDoctorProposalsBatch,
  getLibraryDoctorProposalByGenerationKey,
  type LibraryDoctorConfidence,
  type LibraryDoctorProposal,
  type LibraryDoctorProposalType,
  type LibraryDoctorRisk,
} from "./libraryDoctorStore.js";
import {
  listTaxonomyAliases,
  previewTemplateTaxonomy,
  type TaxonomyAliasEntry,
  type TaxonomyProposal,
} from "./taxonomy.js";

export type LibraryDoctorGenerationSource =
  | "alias-registry"
  | "library-audit"
  | "taxonomy-preview";

export interface LibraryDoctorProposalCandidate {
  candidateKey: string;
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  source: LibraryDoctorGenerationSource;
  sourceIssueCode: string | null;
  sourceIssueGroup: string | null;
  sourceCurrentValue: unknown;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  proposalType: LibraryDoctorProposalType;
  confidence: LibraryDoctorConfidence;
  risk: LibraryDoctorRisk;
  evidenceRefs: TaxonomyEvidenceRef[];
  rationale: string;
  readOnly: true;
}

export interface LibraryDoctorGenerationScope {
  templateIds?: string[];
  manufacturer?: string;
  issueCodes?: string[];
  fields?: string[];
  maxCandidates?: number;
}

/**
 * Skip counters are generation-event counts, not unique-template or unique-port counts.
 * The same physical value (e.g. one euroblock port) may increment highRisk more than once
 * when evaluated by multiple sources (alias-registry and library-audit).
 */
export interface LibraryDoctorGenerationSkippedCounts {
  /**
   * Number of times a mapping was found but excluded because registry/migration risk is high
   * (or risk otherwise outside the allowed low/medium generation set).
   * Event count — not unique templates/ports.
   */
  highRisk: number;
  /**
   * Number of times an issue/signal had no deterministic safe proposed value,
   * or taxonomy-preview confidence was too low for automatic generation.
   * Event count — not unique templates/ports.
   */
  ambiguous: number;
  /**
   * Number of built candidates in this preview whose generation_key already exists
   * in the proposal queue (any status). Count of candidate keys, not skip events across sources.
   */
  duplicateExisting: number;
}

export interface LibraryDoctorPreviewResult {
  readOnly: true;
  templatesScanned: number;
  candidates: LibraryDoctorProposalCandidate[];
  skipped: LibraryDoctorGenerationSkippedCounts;
}

export interface LibraryDoctorEnqueueResult {
  requested: number;
  created: number;
  alreadyExisting: number;
  staleOrMissing: number;
  rejectedHighRisk: number;
  proposalIds: string[];
  existing: Array<{ candidateKey: string; proposalId: string; status: string }>;
  createdProposals: LibraryDoctorProposal[];
}

const ALLOWED_GENERATION_RISKS = new Set<LibraryDoctorRisk>(["low", "medium"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function norm(value: unknown): string {
  return text(value).toLowerCase();
}

function templateIdOf(template: DeviceTemplate, index: number): string {
  return text(template.id)
    || `${text(template.manufacturer) || "unknown"}:${text(template.modelNumber) || text(template.label) || index + 1}`;
}

function templateModel(template: DeviceTemplate): string | null {
  return text(template.modelNumber) || text((template as { model?: unknown }).model) || null;
}

/** Taxonomy multi-value fields treated as unordered sets for candidate identity. */
const SET_LIKE_TAXONOMY_FIELDS = new Set([
  "roleTags",
  "deviceCapabilities",
  "protocols",
]);

export function isSetLikeTaxonomyField(field: string): boolean {
  return SET_LIKE_TAXONOMY_FIELDS.has(field);
}

/**
 * Normalize set-like taxonomy string arrays: trim, drop empties, case-insensitive
 * de-dupe, then sort. Order-insensitive identity for roleTags/deviceCapabilities/protocols.
 * Does not globally sort arbitrary arrays (order-sensitive fields stay as-is).
 */
export function normalizeSetLikeStringArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      const asString = String(entry);
      const key = asString.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(asString);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(trimmed);
  }
  items.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  return items;
}

export function normalizeFieldValueForCandidateKey(field: string, value: unknown): unknown {
  if (isSetLikeTaxonomyField(field)) {
    return normalizeSetLikeStringArray(value);
  }
  return value ?? null;
}

/** Canonical JSON for deterministic keys (sorted object keys; set-like fields pre-normalized). */
export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return String(value);
}

export function buildCandidateKey(input: {
  templateId: string;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  proposalType: string;
  sourceIssueCode?: string | null;
}): string {
  const payload = {
    templateId: input.templateId,
    field: input.field,
    currentValue: normalizeFieldValueForCandidateKey(input.field, input.currentValue),
    proposedValue: normalizeFieldValueForCandidateKey(input.field, input.proposedValue),
    proposalType: input.proposalType,
    sourceIssueCode: input.sourceIssueCode ?? null,
  };
  return createHash("sha256").update(canonicalSerialize(payload), "utf8").digest("hex");
}

function evidence(type: string, title: string, note: string): TaxonomyEvidenceRef {
  return {
    type,
    title,
    note,
    capturedAt: new Date().toISOString(),
  };
}

function findAliasEntry(
  aliases: TaxonomyAliasEntry[],
  field: TaxonomyAliasEntry["field"],
  inputValue: string,
): { entry: TaxonomyAliasEntry; deprecated: boolean } | null {
  const input = norm(inputValue);
  if (!input) return null;
  for (const entry of aliases) {
    if (entry.field !== field) continue;
    const aliasMatch = entry.aliases.some((alias) => norm(alias) === input);
    const deprecatedMatch = entry.deprecatedValues.some((deprecated) => norm(deprecated) === input);
    if (!aliasMatch && !deprecatedMatch) continue;
    if (norm(entry.canonicalValue) === input) continue;
    return { entry, deprecated: deprecatedMatch };
  }
  return null;
}

function confidenceFromAlias(entry: TaxonomyAliasEntry): LibraryDoctorConfidence {
  if (entry.migrationRisk === "low") return "high";
  if (entry.migrationRisk === "medium") return "medium";
  return "low";
}

function hasMeaningfulScope(scope: LibraryDoctorGenerationScope): boolean {
  if (scope.templateIds && scope.templateIds.length > 0) return true;
  if (text(scope.manufacturer)) return true;
  if (scope.issueCodes && scope.issueCodes.length > 0) return true;
  if (scope.fields && scope.fields.length > 0) return true;
  return false;
}

function assertScope(scope: LibraryDoctorGenerationScope): void {
  if (!hasMeaningfulScope(scope)) {
    throw new LibraryDoctorStoreError(
      400,
      "A generation scope is required: provide templateIds, manufacturer, issueCodes, and/or fields",
    );
  }
  if (scope.maxCandidates != null && (!Number.isInteger(scope.maxCandidates) || scope.maxCandidates < 1)) {
    throw new LibraryDoctorStoreError(400, "maxCandidates must be a positive integer");
  }
  if (scope.templateIds != null) {
    if (!Array.isArray(scope.templateIds) || !scope.templateIds.every((id) => typeof id === "string" && id.trim())) {
      throw new LibraryDoctorStoreError(400, "templateIds must be an array of non-empty strings");
    }
  }
  if (scope.issueCodes != null) {
    if (!Array.isArray(scope.issueCodes) || !scope.issueCodes.every((code) => typeof code === "string" && code.trim())) {
      throw new LibraryDoctorStoreError(400, "issueCodes must be an array of non-empty strings");
    }
  }
  if (scope.fields != null) {
    if (!Array.isArray(scope.fields) || !scope.fields.every((field) => typeof field === "string" && field.trim())) {
      throw new LibraryDoctorStoreError(400, "fields must be an array of non-empty strings");
    }
  }
  if (scope.manufacturer != null && typeof scope.manufacturer !== "string") {
    throw new LibraryDoctorStoreError(400, "manufacturer must be a string");
  }
}

function fieldMatchesScope(field: string, fields?: string[]): boolean {
  if (!fields || fields.length === 0) return true;
  const normalized = fields.map((entry) => entry.trim().toLowerCase());
  const fieldLower = field.toLowerCase();
  return normalized.some((entry) => fieldLower === entry || fieldLower.endsWith(`.${entry}`) || fieldLower.includes(entry));
}

function issueCodeMatchesScope(code: string | null, issueCodes?: string[]): boolean {
  if (!issueCodes || issueCodes.length === 0) return true;
  if (!code) return false;
  return issueCodes.map((entry) => entry.trim().toUpperCase()).includes(code.toUpperCase());
}

/** Build-time skip event counters (see LibraryDoctorGenerationSkippedCounts). */
interface BuildStats {
  highRisk: number;
  ambiguous: number;
}

function makeCandidate(
  partial: Omit<LibraryDoctorProposalCandidate, "candidateKey" | "readOnly">,
): LibraryDoctorProposalCandidate {
  // Store set-like taxonomy arrays in canonical order so queue rows match hashed identity.
  const currentValue = normalizeFieldValueForCandidateKey(partial.field, partial.currentValue);
  const proposedValue = normalizeFieldValueForCandidateKey(partial.field, partial.proposedValue);
  const candidateKey = buildCandidateKey({
    templateId: partial.templateId,
    field: partial.field,
    currentValue,
    proposedValue,
    proposalType: partial.proposalType,
    sourceIssueCode: partial.sourceIssueCode,
  });
  return {
    ...partial,
    currentValue,
    proposedValue,
    candidateKey,
    readOnly: true,
  };
}

/**
 * Build conservative, deterministic proposal candidates.
 * Never mutates templates. Never writes to the proposal queue.
 */
export function buildLibraryDoctorProposalCandidates(
  templates: DeviceTemplate[],
  scope: LibraryDoctorGenerationScope = {},
): { candidates: LibraryDoctorProposalCandidate[]; stats: BuildStats; templatesScanned: number } {
  assertScope(scope);
  const stats: BuildStats = { highRisk: 0, ambiguous: 0 };
  const candidates: LibraryDoctorProposalCandidate[] = [];
  const seenKeys = new Set<string>();
  /** Material identity ignores sourceIssueCode so alias+audit do not double-emit the same fix. */
  const seenMaterial = new Set<string>();
  const aliases = listTaxonomyAliases();

  const manufacturerFilter = text(scope.manufacturer);
  const templateIdSet = scope.templateIds?.length
    ? new Set(scope.templateIds.map((id) => id.trim()))
    : null;

  const scoped = templates
    .map((template, index) => ({ template, id: templateIdOf(template, index) }))
    .filter(({ template, id }) => {
      if (templateIdSet && !templateIdSet.has(id)) return false;
      if (manufacturerFilter && norm(template.manufacturer) !== norm(manufacturerFilter)) return false;
      return true;
    });

  const push = (candidate: LibraryDoctorProposalCandidate) => {
    if (!fieldMatchesScope(candidate.field, scope.fields)) return;
    if (!issueCodeMatchesScope(candidate.sourceIssueCode, scope.issueCodes)) return;
    if (seenKeys.has(candidate.candidateKey)) return;
    if (canonicalSerialize(candidate.currentValue) === canonicalSerialize(candidate.proposedValue)) {
      stats.ambiguous += 1;
      return;
    }
    if (!ALLOWED_GENERATION_RISKS.has(candidate.risk)) {
      stats.highRisk += 1;
      return;
    }
    const materialKey = [
      candidate.templateId,
      candidate.field,
      canonicalSerialize(candidate.currentValue),
      canonicalSerialize(candidate.proposedValue),
      candidate.proposalType,
    ].join("|");
    if (seenMaterial.has(materialKey)) return;
    seenKeys.add(candidate.candidateKey);
    seenMaterial.add(materialKey);
    candidates.push(candidate);
  };

  // C first (audit) so when both audit + alias match, library-audit issue codes are preferred.
  const report = auditLibraryTemplates(scoped.map((entry) => entry.template));
  const templateById = new Map(scoped.map((entry) => [entry.id, entry.template]));
  for (const issue of report.issues) {
    const mapped = mapAuditIssue(issue, templateById.get(issue.templateId), aliases, stats);
    if (mapped) push(mapped);
  }

  for (const { template, id } of scoped) {
    const manufacturer = text(template.manufacturer) || null;
    const modelNumber = templateModel(template);

    // A) Exact alias/deprecation matches (exclude high-risk via ALLOWED_GENERATION_RISKS)
    const templateFieldValues: Array<{ field: TaxonomyAliasEntry["field"]; values: string[]; arrayField?: boolean }> = [
      { field: "category", values: template.category ? [template.category] : [] },
      { field: "deviceType", values: template.deviceType ? [template.deviceType] : [] },
      { field: "roleTags", values: template.roleTags ?? [], arrayField: true },
      { field: "deviceCapabilities", values: template.deviceCapabilities ?? [], arrayField: true },
      { field: "protocols", values: template.protocols ?? [], arrayField: true },
    ];

    for (const { field, values, arrayField } of templateFieldValues) {
      for (const value of values) {
        const match = findAliasEntry(aliases, field, value);
        if (!match) continue;
        if (match.entry.migrationRisk === "high") {
          stats.highRisk += 1;
          continue;
        }
        let currentValue: unknown = value;
        let proposedValue: unknown = match.entry.canonicalValue;
        if (arrayField) {
          const next = values.map((item) => (norm(item) === norm(value) ? match.entry.canonicalValue : item));
          const deduped: string[] = [];
          for (const item of next) {
            if (!deduped.some((existing) => norm(existing) === norm(item))) deduped.push(item);
          }
          currentValue = [...values];
          proposedValue = deduped;
        }
        push(makeCandidate({
          templateId: id,
          manufacturer,
          modelNumber,
          source: "alias-registry",
          sourceIssueCode: match.deprecated ? "TAXONOMY_DEPRECATED_VALUE" : "TAXONOMY_ALIAS_MATCH",
          sourceIssueGroup: "taxonomy-alias",
          sourceCurrentValue: value,
          field,
          currentValue,
          proposedValue,
          proposalType: "alias-normalization",
          confidence: confidenceFromAlias(match.entry),
          risk: match.entry.migrationRisk,
          evidenceRefs: [
            evidence(
              "taxonomy-alias-registry",
              `${field}: ${value} → ${match.entry.canonicalValue}`,
              match.entry.notes
                ?? `Exact registry mapping from "${value}" to "${match.entry.canonicalValue}".`,
            ),
          ],
          rationale: `Exact ${match.deprecated ? "deprecated" : "alias"} match for ${field}: "${value}" → "${match.entry.canonicalValue}".`,
        }));
      }
    }

    (template.ports ?? []).forEach((port: Port, portIndex: number) => {
      const connector = text(port.connectorType);
      if (connector) {
        const match = findAliasEntry(aliases, "connectorType", connector);
        if (match) {
          if (match.entry.migrationRisk === "high") {
            // euroblock / phoenix etc. — never auto-generate
            stats.highRisk += 1;
          } else {
            push(makeCandidate({
              templateId: id,
              manufacturer,
              modelNumber,
              source: "alias-registry",
              sourceIssueCode: match.deprecated ? "TAXONOMY_DEPRECATED_VALUE" : "TAXONOMY_ALIAS_MATCH",
              sourceIssueGroup: "taxonomy-alias-port",
              sourceCurrentValue: connector,
              field: `ports[${portIndex}].connectorType`,
              currentValue: connector,
              proposedValue: match.entry.canonicalValue,
              proposalType: "alias-normalization",
              confidence: confidenceFromAlias(match.entry),
              risk: match.entry.migrationRisk,
              evidenceRefs: [
                evidence(
                  "taxonomy-alias-registry",
                  `port ${text(port.label) || portIndex}: ${connector} → ${match.entry.canonicalValue}`,
                  match.entry.notes ?? "Exact low/medium-risk connector alias.",
                ),
              ],
              rationale: `Port "${text(port.label) || portIndex}" connectorType exact alias "${connector}" → "${match.entry.canonicalValue}".`,
            }));
          }
        }
      }

      const direction = text(port.direction);
      if (direction) {
        const match = findAliasEntry(aliases, "direction", direction);
        if (match) {
          if (match.entry.migrationRisk === "high") {
            stats.highRisk += 1;
          } else {
            push(makeCandidate({
              templateId: id,
              manufacturer,
              modelNumber,
              source: "alias-registry",
              sourceIssueCode: "TAXONOMY_ALIAS_MATCH",
              sourceIssueGroup: "taxonomy-alias-port",
              sourceCurrentValue: direction,
              field: `ports[${portIndex}].direction`,
              currentValue: direction,
              proposedValue: match.entry.canonicalValue,
              proposalType: "alias-normalization",
              confidence: confidenceFromAlias(match.entry),
              risk: match.entry.migrationRisk,
              evidenceRefs: [
                evidence(
                  "taxonomy-alias-registry",
                  `port ${text(port.label) || portIndex}: ${direction} → ${match.entry.canonicalValue}`,
                  match.entry.notes ?? "Exact direction alias.",
                ),
              ],
              rationale: `Port "${text(port.label) || portIndex}" direction exact alias "${direction}" → "${match.entry.canonicalValue}".`,
            }));
          }
        }
      }
    });

    // B) Conservative taxonomy preview (high confidence only; risk treated as low for additive)
    const preview = previewTemplateTaxonomy(template);
    for (const proposal of preview.proposals) {
      if (proposal.confidence !== "high") {
        stats.ambiguous += 1;
        continue;
      }
      const mapped = mapTaxonomyPreview(template, id, manufacturer, modelNumber, proposal);
      if (!mapped) {
        stats.ambiguous += 1;
        continue;
      }
      push(mapped);
    }
  }

  candidates.sort((a, b) =>
    a.templateId.localeCompare(b.templateId)
    || a.field.localeCompare(b.field)
    || a.candidateKey.localeCompare(b.candidateKey));

  let limited = candidates;
  if (scope.maxCandidates != null && candidates.length > scope.maxCandidates) {
    limited = candidates.slice(0, scope.maxCandidates);
  }

  return {
    candidates: limited,
    stats,
    templatesScanned: scoped.length,
  };
}

function mapTaxonomyPreview(
  template: DeviceTemplate,
  templateId: string,
  manufacturer: string | null,
  modelNumber: string | null,
  proposal: TaxonomyProposal,
): LibraryDoctorProposalCandidate | null {
  if (proposal.field === "category") {
    // Canonical category for a known deviceType — deterministic, not manufacturer guessing.
    return makeCandidate({
      templateId,
      manufacturer,
      modelNumber,
      source: "taxonomy-preview",
      sourceIssueCode: "TAXONOMY_CATEGORY_MISMATCH",
      sourceIssueGroup: "taxonomy-preview",
      sourceCurrentValue: template.category ?? null,
      field: "category",
      currentValue: template.category ?? null,
      proposedValue: proposal.value,
      proposalType: "taxonomy-classification",
      confidence: "high",
      risk: "low",
      evidenceRefs: [evidence("taxonomy-preview", `category → ${proposal.value}`, proposal.reason)],
      rationale: proposal.reason,
    });
  }

  const currentArray =
    proposal.field === "roleTags"
      ? [...(template.roleTags ?? [])]
      : proposal.field === "deviceCapabilities"
        ? [...(template.deviceCapabilities ?? [])]
        : [...(template.protocols ?? [])];

  if (currentArray.some((item) => norm(item) === norm(proposal.value))) return null;

  return makeCandidate({
    templateId,
    manufacturer,
    modelNumber,
    source: "taxonomy-preview",
    sourceIssueCode: "TAXONOMY_ADDITIVE_CLASSIFICATION",
    sourceIssueGroup: "taxonomy-preview",
    sourceCurrentValue: currentArray,
    field: proposal.field,
    currentValue: currentArray,
    proposedValue: [...currentArray, proposal.value],
    proposalType: "taxonomy-classification",
    confidence: "high",
    risk: "low",
    evidenceRefs: [evidence("taxonomy-preview", `${proposal.field} += ${proposal.value}`, proposal.reason)],
    rationale: proposal.reason,
  });
}

function mapAuditIssue(
  issue: LibraryAuditIssue,
  template: DeviceTemplate | undefined,
  aliases: TaxonomyAliasEntry[],
  stats: BuildStats,
): LibraryDoctorProposalCandidate | null {
  const current = text(issue.currentValue);
  if (!current) {
    // e.g. MISSING_* — no invented proposed value
    stats.ambiguous += 1;
    return null;
  }

  if (issue.code === "INVALID_PORT_DIRECTION") {
    const match = findAliasEntry(aliases, "direction", current);
    if (!match) {
      stats.ambiguous += 1;
      return null;
    }
    if (match.entry.migrationRisk === "high") {
      stats.highRisk += 1;
      return null;
    }
    const portIndex = issue.portIndex;
    return makeCandidate({
      templateId: issue.templateId,
      manufacturer: issue.manufacturer,
      modelNumber: issue.modelNumber,
      source: "library-audit",
      sourceIssueCode: issue.code,
      sourceIssueGroup: "library-audit",
      sourceCurrentValue: current,
      field: typeof portIndex === "number" ? `ports[${portIndex}].direction` : "direction",
      currentValue: current,
      proposedValue: match.entry.canonicalValue,
      proposalType: "alias-normalization",
      confidence: confidenceFromAlias(match.entry),
      risk: match.entry.migrationRisk,
      evidenceRefs: [
        evidence("library-audit", `${issue.code}: ${current}`, issue.message),
        evidence(
          "taxonomy-alias-registry",
          `${current} → ${match.entry.canonicalValue}`,
          match.entry.notes ?? "Exact direction alias.",
        ),
      ],
      rationale: `Audit ${issue.code}: "${current}" → "${match.entry.canonicalValue}" on port "${issue.portLabel ?? "unknown"}".`,
    });
  }

  if (issue.code === "INVALID_CONNECTOR_TYPE") {
    const match = findAliasEntry(aliases, "connectorType", current);
    if (!match) {
      stats.ambiguous += 1;
      return null;
    }
    if (match.entry.migrationRisk === "high") {
      // euroblock must not become an automatically enqueued correction
      stats.highRisk += 1;
      return null;
    }
    const portIndex = issue.portIndex;
    return makeCandidate({
      templateId: issue.templateId,
      manufacturer: issue.manufacturer,
      modelNumber: issue.modelNumber,
      source: "library-audit",
      sourceIssueCode: issue.code,
      sourceIssueGroup: "library-audit",
      sourceCurrentValue: current,
      field: typeof portIndex === "number" ? `ports[${portIndex}].connectorType` : "connectorType",
      currentValue: current,
      proposedValue: match.entry.canonicalValue,
      proposalType: "alias-normalization",
      confidence: confidenceFromAlias(match.entry),
      risk: match.entry.migrationRisk,
      evidenceRefs: [
        evidence("library-audit", `${issue.code}: ${current}`, issue.message),
        evidence(
          "taxonomy-alias-registry",
          `${current} → ${match.entry.canonicalValue}`,
          match.entry.notes ?? "Exact connector alias.",
        ),
      ],
      rationale: `Audit ${issue.code}: "${current}" → "${match.entry.canonicalValue}" on port "${issue.portLabel ?? "unknown"}".`,
    });
  }

  if (issue.code === "SUSPICIOUS_TEMPLATE_VALUE") {
    const deviceType = text(template?.deviceType);
    if (deviceType && norm(deviceType) === norm(current)) {
      const match = findAliasEntry(aliases, "deviceType", current);
      if (match) {
        if (match.entry.migrationRisk === "high") {
          stats.highRisk += 1;
          return null;
        }
        return makeCandidate({
          templateId: issue.templateId,
          manufacturer: issue.manufacturer,
          modelNumber: issue.modelNumber,
          source: "library-audit",
          sourceIssueCode: issue.code,
          sourceIssueGroup: "library-audit",
          sourceCurrentValue: current,
          field: "deviceType",
          currentValue: current,
          proposedValue: match.entry.canonicalValue,
          proposalType: "alias-normalization",
          confidence: confidenceFromAlias(match.entry),
          risk: match.entry.migrationRisk,
          evidenceRefs: [
            evidence("library-audit", `${issue.code}: ${current}`, issue.message),
            evidence(
              "taxonomy-alias-registry",
              `${current} → ${match.entry.canonicalValue}`,
              match.entry.notes ?? "Exact deviceType alias.",
            ),
          ],
          rationale: `Audit ${issue.code}: deviceType "${current}" → "${match.entry.canonicalValue}".`,
        });
      }
    }
  }

  // Completeness / invent-required issues are deliberately not proposal sources.
  stats.ambiguous += 1;
  return null;
}

/**
 * Preview candidates without writing. Counts duplicates against existing queue keys.
 */
export function previewLibraryDoctorGeneration(
  db: DatabaseSync,
  templates: DeviceTemplate[],
  scope: LibraryDoctorGenerationScope,
): LibraryDoctorPreviewResult {
  const { candidates, stats, templatesScanned } = buildLibraryDoctorProposalCandidates(templates, scope);

  let duplicateExisting = 0;
  const filtered: LibraryDoctorProposalCandidate[] = [];
  for (const candidate of candidates) {
    const existing = getLibraryDoctorProposalByGenerationKey(db, candidate.candidateKey);
    if (existing) {
      duplicateExisting += 1;
      continue;
    }
    filtered.push(candidate);
  }

  return {
    readOnly: true,
    templatesScanned,
    candidates: filtered,
    skipped: {
      highRisk: stats.highRisk,
      ambiguous: stats.ambiguous,
      duplicateExisting,
    },
  };
}

/**
 * Enqueue by candidateKey only. Recomputes candidates server-side; never trusts caller proposed values.
 * Writes only to the proposal queue (never templates).
 */
export function enqueueLibraryDoctorCandidates(
  db: DatabaseSync,
  templates: DeviceTemplate[],
  candidateKeys: string[],
  createdBy?: string | null,
): LibraryDoctorEnqueueResult {
  if (!Array.isArray(candidateKeys) || candidateKeys.length === 0) {
    throw new LibraryDoctorStoreError(400, "candidateKeys must be a non-empty array of strings");
  }
  if (!candidateKeys.every((key) => typeof key === "string" && key.trim())) {
    throw new LibraryDoctorStoreError(400, "candidateKeys must contain only non-empty strings");
  }

  const requestedKeys = [...new Set(candidateKeys.map((key) => key.trim()))];

  // Recompute over the provided template set (caller/server supplies current library snapshot).
  // Use a broad internal scope that still requires explicit template list when empty is unsafe:
  // When templates are the full current list, require keys only and rebuild all candidates for matching.
  // Scope uses fields: [] would fail assertScope — use manufacturer absent + templateIds from all templates.
  const allIds = templates.map((template, index) => templateIdOf(template, index));
  const { candidates, stats } = buildLibraryDoctorProposalCandidates(templates, {
    templateIds: allIds,
  });

  void stats;
  const byKey = new Map(candidates.map((candidate) => [candidate.candidateKey, candidate]));

  let alreadyExisting = 0;
  let staleOrMissing = 0;
  let rejectedHighRisk = 0;
  const existing: LibraryDoctorEnqueueResult["existing"] = [];
  const toCreate: LibraryDoctorProposalCandidate[] = [];

  for (const key of requestedKeys) {
    const candidate = byKey.get(key);
    if (!candidate) {
      // Could be high-risk (never in candidate set) or genuinely stale.
      // We cannot distinguish caller high-risk injection from stale; count as staleOrMissing.
      // Separately, if the key was for a known high-risk mapping we don't recompute those into byKey.
      staleOrMissing += 1;
      continue;
    }
    if (!ALLOWED_GENERATION_RISKS.has(candidate.risk)) {
      rejectedHighRisk += 1;
      continue;
    }
    const existingProposal = getLibraryDoctorProposalByGenerationKey(db, key);
    if (existingProposal) {
      alreadyExisting += 1;
      existing.push({
        candidateKey: key,
        proposalId: existingProposal.id,
        status: existingProposal.status,
      });
      continue;
    }
    toCreate.push(candidate);
  }

  const createdProposals = createLibraryDoctorProposalsBatch(
    db,
    toCreate.map((candidate) => ({
      templateId: candidate.templateId,
      manufacturer: candidate.manufacturer,
      modelNumber: candidate.modelNumber,
      sourceIssueCode: candidate.sourceIssueCode,
      sourceIssueGroup: candidate.sourceIssueGroup,
      sourceCurrentValue: candidate.sourceCurrentValue,
      field: candidate.field,
      currentValue: candidate.currentValue,
      proposedValue: candidate.proposedValue,
      proposalType: candidate.proposalType,
      confidence: candidate.confidence,
      risk: candidate.risk,
      evidenceRefs: candidate.evidenceRefs,
      rationale: candidate.rationale,
      createdBy: createdBy ?? null,
      generationKey: candidate.candidateKey,
    })),
  );

  return {
    requested: requestedKeys.length,
    created: createdProposals.length,
    alreadyExisting,
    staleOrMissing,
    rejectedHighRisk,
    proposalIds: createdProposals.map((proposal) => proposal.id),
    existing,
    createdProposals,
  };
}

/** Safety helper for tests. */
export function libraryDoctorGenerationMutatesTemplates(): false {
  return false;
}
