import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TaxonomyEvidenceRef } from "../../src/types.js";

export type LibraryDoctorProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "needs-manual-review"
  | "superseded";

export type LibraryDoctorConfidence = "low" | "medium" | "high";
export type LibraryDoctorRisk = "low" | "medium" | "high";

export type LibraryDoctorProposalType =
  | "field-value-change"
  | "taxonomy-classification"
  | "alias-normalization"
  | "completeness-fill"
  | "other";

export type LibraryDoctorEventType = "created" | "reviewed" | "superseded";

export class LibraryDoctorStoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LibraryDoctorStoreError";
    this.status = status;
  }
}

export interface LibraryDoctorProposalPreview {
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  readOnly: true;
  arrayDiff?: {
    added: unknown[];
    removed: unknown[];
  };
}

export interface LibraryDoctorProposal {
  id: string;
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
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
  rationale: string | null;
  status: LibraryDoctorProposalStatus;
  createdAt: string;
  createdBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  supersedesProposalId: string | null;
  preview: LibraryDoctorProposalPreview;
}

export interface LibraryDoctorProposalEvent {
  id: string;
  proposalId: string;
  oldStatus: LibraryDoctorProposalStatus | null;
  newStatus: LibraryDoctorProposalStatus;
  reviewer: string | null;
  reviewNote: string | null;
  eventType: LibraryDoctorEventType;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CreateLibraryDoctorProposalInput {
  templateId: unknown;
  manufacturer?: unknown;
  modelNumber?: unknown;
  sourceIssueCode?: unknown;
  sourceIssueGroup?: unknown;
  sourceCurrentValue?: unknown;
  field: unknown;
  currentValue?: unknown;
  proposedValue?: unknown;
  proposalType: unknown;
  confidence?: unknown;
  risk?: unknown;
  evidenceRefs?: unknown;
  rationale?: unknown;
  createdBy?: string | null;
  supersedesProposalId?: unknown;
}

export interface LibraryDoctorProposalFilters {
  status?: string;
  manufacturer?: string;
  templateId?: string;
  field?: string;
  proposalType?: string;
  confidence?: string;
  risk?: string;
  sourceIssueCode?: string;
}

export interface ReviewLibraryDoctorProposalInput {
  status: unknown;
  reviewNote?: unknown;
  reviewedBy?: string | null;
}

export interface SupersedeLibraryDoctorProposalInput {
  reviewNote?: unknown;
  reviewedBy?: string | null;
  replacement?: CreateLibraryDoctorProposalInput;
}

const STATUSES = new Set<LibraryDoctorProposalStatus>([
  "pending",
  "accepted",
  "rejected",
  "needs-manual-review",
  "superseded",
]);

const CONFIDENCES = new Set<LibraryDoctorConfidence>(["low", "medium", "high"]);
const RISKS = new Set<LibraryDoctorRisk>(["low", "medium", "high"]);
const PROPOSAL_TYPES = new Set<LibraryDoctorProposalType>([
  "field-value-change",
  "taxonomy-classification",
  "alias-normalization",
  "completeness-fill",
  "other",
]);

/** Allowed review-queue transitions. Accepted means approved in queue only — never applied. */
const ALLOWED_TRANSITIONS: Record<LibraryDoctorProposalStatus, readonly LibraryDoctorProposalStatus[]> = {
  pending: ["accepted", "rejected", "needs-manual-review", "superseded"],
  "needs-manual-review": ["accepted", "rejected", "pending", "superseded"],
  accepted: ["superseded"],
  rejected: [],
  superseded: [],
};

interface ProposalRow {
  id: string;
  template_id: string;
  manufacturer: string | null;
  model_number: string | null;
  source_issue_code: string | null;
  source_issue_group: string | null;
  source_current_value_json: string | null;
  field: string;
  current_value_json: string | null;
  proposed_value_json: string | null;
  proposal_type: string;
  confidence: string;
  risk: string;
  evidence_refs_json: string;
  rationale: string | null;
  status: string;
  created_at: string;
  created_by: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  supersedes_proposal_id: string | null;
}

interface EventRow {
  id: string;
  proposal_id: string;
  old_status: string | null;
  new_status: string;
  reviewer: string | null;
  review_note: string | null;
  event_type: string;
  details_json: string;
  created_at: string;
}

function parseJsonValue(raw: string | null): unknown {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function serializeJsonValue(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value === undefined ? null : value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LibraryDoctorStoreError(400, `${label} is required`);
  }
  if (value.length > 500) {
    throw new LibraryDoctorStoreError(400, `${label} exceeds 500 characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new LibraryDoctorStoreError(400, `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) {
    throw new LibraryDoctorStoreError(400, `${label} exceeds 500 characters`);
  }
  return trimmed;
}

function optionalLongString(value: unknown, label: string, max = 4000): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new LibraryDoctorStoreError(400, `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new LibraryDoctorStoreError(400, `${label} exceeds ${max} characters`);
  }
  return trimmed;
}

function parseEnum<T extends string>(value: unknown, label: string, allowed: Set<T>, fallback?: T): T {
  if (value == null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new LibraryDoctorStoreError(400, `${label} is required`);
  }
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new LibraryDoctorStoreError(400, `${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return value as T;
}

function parseEvidenceRefs(value: unknown): TaxonomyEvidenceRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new LibraryDoctorStoreError(400, "evidenceRefs must be an array");
  }
  if (value.length > 50) {
    throw new LibraryDoctorStoreError(400, "evidenceRefs exceeds 50 entries");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LibraryDoctorStoreError(400, `evidenceRefs[${index}] must be an object`);
    }
    const ref = entry as Record<string, unknown>;
    const type = requireNonEmptyString(ref.type, `evidenceRefs[${index}].type`);
    const asOptional = (key: string): string | undefined => {
      const v = ref[key];
      if (v == null || v === "") return undefined;
      if (typeof v !== "string") {
        throw new LibraryDoctorStoreError(400, `evidenceRefs[${index}].${key} must be a string`);
      }
      const trimmed = v.trim();
      if (trimmed.length > 2000) {
        throw new LibraryDoctorStoreError(400, `evidenceRefs[${index}].${key} exceeds 2000 characters`);
      }
      return trimmed || undefined;
    };
    return {
      type,
      url: asOptional("url"),
      title: asOptional("title"),
      excerpt: asOptional("excerpt"),
      note: asOptional("note"),
      capturedAt: asOptional("capturedAt"),
    };
  });
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildArrayDiff(currentValue: unknown, proposedValue: unknown): LibraryDoctorProposalPreview["arrayDiff"] | undefined {
  if (!Array.isArray(currentValue) || !Array.isArray(proposedValue)) {
    return undefined;
  }
  const current = currentValue as unknown[];
  const proposed = proposedValue as unknown[];
  const added = proposed.filter((item) => !current.some((existing) => valuesEqual(existing, item)));
  const removed = current.filter((item) => !proposed.some((existing) => valuesEqual(existing, item)));
  return { added, removed };
}

export function buildProposalPreview(
  field: string,
  currentValue: unknown,
  proposedValue: unknown,
): LibraryDoctorProposalPreview {
  const arrayDiff = buildArrayDiff(currentValue, proposedValue);
  return {
    field,
    currentValue: currentValue ?? null,
    proposedValue: proposedValue ?? null,
    readOnly: true,
    ...(arrayDiff ? { arrayDiff } : {}),
  };
}

function asProposal(row: ProposalRow): LibraryDoctorProposal {
  const currentValue = parseJsonValue(row.current_value_json);
  const proposedValue = parseJsonValue(row.proposed_value_json);
  const evidenceRefs = parseJsonValue(row.evidence_refs_json);
  return {
    id: row.id,
    templateId: row.template_id,
    manufacturer: row.manufacturer,
    modelNumber: row.model_number,
    sourceIssueCode: row.source_issue_code,
    sourceIssueGroup: row.source_issue_group,
    sourceCurrentValue: parseJsonValue(row.source_current_value_json),
    field: row.field,
    currentValue,
    proposedValue,
    proposalType: row.proposal_type as LibraryDoctorProposalType,
    confidence: row.confidence as LibraryDoctorConfidence,
    risk: row.risk as LibraryDoctorRisk,
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs as TaxonomyEvidenceRef[] : [],
    rationale: row.rationale,
    status: row.status as LibraryDoctorProposalStatus,
    createdAt: row.created_at,
    createdBy: row.created_by,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    supersedesProposalId: row.supersedes_proposal_id,
    preview: buildProposalPreview(row.field, currentValue, proposedValue),
  };
}

function asEvent(row: EventRow): LibraryDoctorProposalEvent {
  const details = parseJsonValue(row.details_json);
  return {
    id: row.id,
    proposalId: row.proposal_id,
    oldStatus: row.old_status as LibraryDoctorProposalStatus | null,
    newStatus: row.new_status as LibraryDoctorProposalStatus,
    reviewer: row.reviewer,
    reviewNote: row.review_note,
    eventType: row.event_type as LibraryDoctorEventType,
    details: details && typeof details === "object" && !Array.isArray(details)
      ? details as Record<string, unknown>
      : {},
    createdAt: row.created_at,
  };
}

function getProposalRow(db: DatabaseSync, proposalId: string): ProposalRow | undefined {
  return db.prepare(`
    SELECT *
    FROM library_doctor_proposals
    WHERE id = ?
  `).get(proposalId) as ProposalRow | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendEvent(
  db: DatabaseSync,
  proposalId: string,
  eventType: LibraryDoctorEventType,
  oldStatus: LibraryDoctorProposalStatus | null,
  newStatus: LibraryDoctorProposalStatus,
  reviewer: string | null,
  reviewNote: string | null,
  details: Record<string, unknown> = {},
): void {
  db.prepare(`
    INSERT INTO library_doctor_proposal_events (
      id,
      proposal_id,
      old_status,
      new_status,
      reviewer,
      review_note,
      event_type,
      details_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    proposalId,
    oldStatus,
    newStatus,
    reviewer,
    reviewNote,
    eventType,
    JSON.stringify(details),
    nowIso(),
  );
}

function prepareCreateInput(input: CreateLibraryDoctorProposalInput): {
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
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
  rationale: string | null;
  createdBy: string | null;
  supersedesProposalId: string | null;
} {
  return {
    templateId: requireNonEmptyString(input.templateId, "templateId"),
    manufacturer: optionalString(input.manufacturer, "manufacturer"),
    modelNumber: optionalString(input.modelNumber, "modelNumber"),
    sourceIssueCode: optionalString(input.sourceIssueCode, "sourceIssueCode"),
    sourceIssueGroup: optionalString(input.sourceIssueGroup, "sourceIssueGroup"),
    sourceCurrentValue: input.sourceCurrentValue === undefined ? null : input.sourceCurrentValue,
    field: requireNonEmptyString(input.field, "field"),
    currentValue: input.currentValue === undefined ? null : input.currentValue,
    proposedValue: input.proposedValue === undefined ? null : input.proposedValue,
    proposalType: parseEnum(input.proposalType, "proposalType", PROPOSAL_TYPES),
    confidence: parseEnum(input.confidence, "confidence", CONFIDENCES, "medium"),
    risk: parseEnum(input.risk, "risk", RISKS, "medium"),
    evidenceRefs: parseEvidenceRefs(input.evidenceRefs),
    rationale: optionalLongString(input.rationale, "rationale"),
    createdBy: input.createdBy ?? null,
    supersedesProposalId: optionalString(input.supersedesProposalId, "supersedesProposalId"),
  };
}

function assertTransition(from: LibraryDoctorProposalStatus, to: LibraryDoctorProposalStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new LibraryDoctorStoreError(
      409,
      `Invalid status transition from "${from}" to "${to}"`,
    );
  }
}

export function createLibraryDoctorProposal(
  db: DatabaseSync,
  input: CreateLibraryDoctorProposalInput,
): LibraryDoctorProposal {
  const prepared = prepareCreateInput(input);
  const id = randomUUID();

  if (prepared.supersedesProposalId) {
    if (prepared.supersedesProposalId === id) {
      throw new LibraryDoctorStoreError(400, "supersedesProposalId cannot reference the proposal itself");
    }
    const previous = getProposalRow(db, prepared.supersedesProposalId);
    if (!previous) {
      throw new LibraryDoctorStoreError(400, "supersedesProposalId does not reference an existing proposal");
    }
  }

  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO library_doctor_proposals (
        id,
        template_id,
        manufacturer,
        model_number,
        source_issue_code,
        source_issue_group,
        source_current_value_json,
        field,
        current_value_json,
        proposed_value_json,
        proposal_type,
        confidence,
        risk,
        evidence_refs_json,
        rationale,
        status,
        created_at,
        created_by,
        reviewed_at,
        reviewed_by,
        review_note,
        supersedes_proposal_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?)
    `).run(
      id,
      prepared.templateId,
      prepared.manufacturer,
      prepared.modelNumber,
      prepared.sourceIssueCode,
      prepared.sourceIssueGroup,
      serializeJsonValue(prepared.sourceCurrentValue),
      prepared.field,
      serializeJsonValue(prepared.currentValue),
      serializeJsonValue(prepared.proposedValue),
      prepared.proposalType,
      prepared.confidence,
      prepared.risk,
      JSON.stringify(prepared.evidenceRefs),
      prepared.rationale,
      createdAt,
      prepared.createdBy,
      prepared.supersedesProposalId,
    );

    appendEvent(db, id, "created", null, "pending", prepared.createdBy, null, {
      field: prepared.field,
      proposalType: prepared.proposalType,
      templateId: prepared.templateId,
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failures when no transaction is active
    }
    throw error;
  }

  const saved = getProposalRow(db, id);
  if (!saved) {
    throw new LibraryDoctorStoreError(500, "Could not load created proposal");
  }
  return asProposal(saved);
}

export function getLibraryDoctorProposal(db: DatabaseSync, proposalId: string): LibraryDoctorProposal {
  const row = getProposalRow(db, proposalId);
  if (!row) {
    throw new LibraryDoctorStoreError(404, "Proposal not found");
  }
  return asProposal(row);
}

export function listLibraryDoctorProposals(
  db: DatabaseSync,
  filters: LibraryDoctorProposalFilters = {},
): LibraryDoctorProposal[] {
  const clauses: string[] = [];
  const params: string[] = [];

  const addEq = (column: string, value: string | undefined, label: string, allowed?: Set<string>) => {
    if (value == null || value === "") return;
    if (allowed && !allowed.has(value)) {
      throw new LibraryDoctorStoreError(400, `${label} must be one of: ${[...allowed].join(", ")}`);
    }
    clauses.push(`${column} = ?`);
    params.push(value);
  };

  addEq("status", filters.status, "status", STATUSES as Set<string>);
  addEq("proposal_type", filters.proposalType, "proposalType", PROPOSAL_TYPES as Set<string>);
  addEq("confidence", filters.confidence, "confidence", CONFIDENCES as Set<string>);
  addEq("risk", filters.risk, "risk", RISKS as Set<string>);
  addEq("template_id", filters.templateId, "templateId");
  addEq("field", filters.field, "field");
  addEq("source_issue_code", filters.sourceIssueCode, "sourceIssueCode");

  if (filters.manufacturer != null && filters.manufacturer !== "") {
    clauses.push("lower(coalesce(manufacturer, '')) = lower(?)");
    params.push(filters.manufacturer.trim());
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT *
    FROM library_doctor_proposals
    ${where}
    ORDER BY created_at DESC, id DESC
  `).all(...params) as unknown as ProposalRow[];

  return rows.map(asProposal);
}

export function reviewLibraryDoctorProposal(
  db: DatabaseSync,
  proposalId: string,
  input: ReviewLibraryDoctorProposalInput,
): LibraryDoctorProposal {
  const existing = getProposalRow(db, proposalId);
  if (!existing) {
    throw new LibraryDoctorStoreError(404, "Proposal not found");
  }

  const nextStatus = parseEnum(input.status, "status", STATUSES);
  const currentStatus = existing.status as LibraryDoctorProposalStatus;
  if (nextStatus === currentStatus) {
    throw new LibraryDoctorStoreError(400, `Proposal is already "${currentStatus}"`);
  }
  assertTransition(currentStatus, nextStatus);

  const reviewNote = optionalLongString(input.reviewNote, "reviewNote");
  const reviewedBy = input.reviewedBy ?? null;
  const reviewedAt = nowIso();

  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE library_doctor_proposals
      SET
        status = ?,
        reviewed_at = ?,
        reviewed_by = ?,
        review_note = ?
      WHERE id = ?
    `).run(nextStatus, reviewedAt, reviewedBy, reviewNote, proposalId);

    appendEvent(db, proposalId, "reviewed", currentStatus, nextStatus, reviewedBy, reviewNote, {
      transition: `${currentStatus} -> ${nextStatus}`,
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failures when no transaction is active
    }
    throw error;
  }

  return getLibraryDoctorProposal(db, proposalId);
}

export function listLibraryDoctorProposalHistory(
  db: DatabaseSync,
  proposalId: string,
): LibraryDoctorProposalEvent[] {
  // History is retained by proposal id even if the proposal row is missing later.
  // For active API use we still require the proposal to exist for a clear 404.
  const existing = getProposalRow(db, proposalId);
  if (!existing) {
    throw new LibraryDoctorStoreError(404, "Proposal not found");
  }

  const rows = db.prepare(`
    SELECT *
    FROM library_doctor_proposal_events
    WHERE proposal_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(proposalId) as unknown as EventRow[];

  return rows.map(asEvent);
}

/**
 * Mark a proposal as superseded. Optionally create a replacement proposal in the same transaction.
 * Does not mutate templates.
 */
export function supersedeLibraryDoctorProposal(
  db: DatabaseSync,
  proposalId: string,
  input: SupersedeLibraryDoctorProposalInput = {},
): { proposal: LibraryDoctorProposal; replacement: LibraryDoctorProposal | null } {
  const existing = getProposalRow(db, proposalId);
  if (!existing) {
    throw new LibraryDoctorStoreError(404, "Proposal not found");
  }

  const currentStatus = existing.status as LibraryDoctorProposalStatus;
  assertTransition(currentStatus, "superseded");

  const reviewNote = optionalLongString(input.reviewNote, "reviewNote");
  const reviewedBy = input.reviewedBy ?? null;
  const reviewedAt = nowIso();

  // Validate replacement payload before opening the write transaction so a bad
  // replacement cannot leave a partially superseded original.
  let preparedReplacement: ReturnType<typeof prepareCreateInput> | null = null;
  if (input.replacement) {
    preparedReplacement = prepareCreateInput({
      ...input.replacement,
      createdBy: input.replacement.createdBy ?? reviewedBy,
      // Replacement always soft-links to the proposal being superseded (never self).
      supersedesProposalId: proposalId,
    });
  }

  let replacementId: string | null = null;
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE library_doctor_proposals
      SET
        status = 'superseded',
        reviewed_at = ?,
        reviewed_by = ?,
        review_note = ?
      WHERE id = ?
    `).run(reviewedAt, reviewedBy, reviewNote, proposalId);

    appendEvent(db, proposalId, "superseded", currentStatus, "superseded", reviewedBy, reviewNote, {
      transition: `${currentStatus} -> superseded`,
    });

    if (preparedReplacement) {
      replacementId = randomUUID();
      if (replacementId === proposalId) {
        throw new LibraryDoctorStoreError(500, "Replacement proposal id collision with original");
      }
      const createdAt = nowIso();
      db.prepare(`
        INSERT INTO library_doctor_proposals (
          id,
          template_id,
          manufacturer,
          model_number,
          source_issue_code,
          source_issue_group,
          source_current_value_json,
          field,
          current_value_json,
          proposed_value_json,
          proposal_type,
          confidence,
          risk,
          evidence_refs_json,
          rationale,
          status,
          created_at,
          created_by,
          reviewed_at,
          reviewed_by,
          review_note,
          supersedes_proposal_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?)
      `).run(
        replacementId,
        preparedReplacement.templateId,
        preparedReplacement.manufacturer,
        preparedReplacement.modelNumber,
        preparedReplacement.sourceIssueCode,
        preparedReplacement.sourceIssueGroup,
        serializeJsonValue(preparedReplacement.sourceCurrentValue),
        preparedReplacement.field,
        serializeJsonValue(preparedReplacement.currentValue),
        serializeJsonValue(preparedReplacement.proposedValue),
        preparedReplacement.proposalType,
        preparedReplacement.confidence,
        preparedReplacement.risk,
        JSON.stringify(preparedReplacement.evidenceRefs),
        preparedReplacement.rationale,
        createdAt,
        preparedReplacement.createdBy,
        proposalId,
      );
      appendEvent(db, replacementId, "created", null, "pending", preparedReplacement.createdBy, null, {
        supersedesProposalId: proposalId,
        field: preparedReplacement.field,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failures when no transaction is active
    }
    throw error;
  }

  return {
    proposal: getLibraryDoctorProposal(db, proposalId),
    replacement: replacementId ? getLibraryDoctorProposal(db, replacementId) : null,
  };
}

/** Explicit safety helper for tests: no template-write symbols are exported from this module. */
export function libraryDoctorMutatesTemplates(): false {
  return false;
}
