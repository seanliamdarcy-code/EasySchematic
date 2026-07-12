import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CONNECTOR_LABELS, SIGNAL_LABELS, type DeviceTemplate, type Port } from "../../src/types.js";
import { listCurrentTemplates } from "./deviceStore.js";
import {
  createLibraryDoctorProposal,
  getLibraryDoctorProposalByGenerationKey,
  type LibraryDoctorConfidence,
} from "./libraryDoctorStore.js";
import { getTaxonomyVocabularies } from "./taxonomy.js";
import { listRegistryValues, type TaxonomyRegistryKind } from "./taxonomyRegistryStore.js";

const DIRECTIONS = new Set(["input", "output", "bidirectional", "passthrough"]);
const RACK_FORMS = new Set(["full", "half", "shelf-only"]);
const CONNECTORS = new Set(Object.keys(CONNECTOR_LABELS));
const SIGNALS = new Set(Object.keys(SIGNAL_LABELS));
const MAX_STRING_ARRAY_ENTRIES = 100;
const MAX_PORTS = 500;
const CANONICAL_FIELDS = new Set([
  "manufacturer", "modelNumber", "label", "shortName", "category", "deviceType", "roleTags",
  "deviceCapabilities", "protocols", "heightMm", "widthMm", "depthMm", "weightKg", "rackForm",
  "ports", "searchTerms", "referenceUrl",
]);

export interface CreateNewTemplateProposalInput {
  proposedTemplate: unknown;
  identityAliases?: unknown;
  evidenceRefs?: unknown;
  rationale?: unknown;
  classificationConfidence?: unknown;
  risk?: unknown;
  historicalUsageEvidence?: unknown;
  operationalNotes?: unknown;
  createdBy?: string | null;
  supersedesProposalId?: unknown;
  generationKey?: unknown;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function string(value: unknown, label: string, issues: string[], required = false): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    if (required) issues.push(`${label} is required`);
    else if (value != null) issues.push(`${label} must be a non-empty string`);
    return undefined;
  }
  const result = value.trim();
  if (result.length > 500) issues.push(`${label} exceeds 500 characters`);
  return result;
}

function strings(value: unknown, label: string, issues: string[], maxEntries = MAX_STRING_ARRAY_ENTRIES): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) { issues.push(`${label} must be an array`); return []; }
  if (value.length > maxEntries) { issues.push(`${label} exceeds ${maxEntries} entries`); return []; }
  const result: string[] = [];
  value.forEach((item, index) => {
    const parsed = string(item, `${label}[${index}]`, issues, true);
    if (parsed && !result.includes(parsed)) result.push(parsed);
  });
  return result;
}

function positiveNumber(value: unknown, label: string, issues: string[]): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`${label} must be a positive number`);
    return undefined;
  }
  return value;
}

function effectiveValues(db: DatabaseSync, kind: TaxonomyRegistryKind): Set<string> {
  const registry = listRegistryValues(db, kind).filter((value) => value.status === "active").map((value) => value.value);
  if (registry.length) return new Set(registry);
  const fallback = getTaxonomyVocabularies();
  if (kind === "category") return new Set(fallback.categories);
  if (kind === "deviceType") return new Set(fallback.deviceTypes.map((value) => value.value));
  if (kind === "roleTag") return new Set(fallback.roleTags);
  if (kind === "deviceCapability") return new Set(fallback.deviceCapabilities);
  return new Set(fallback.protocols);
}

function validatePorts(value: unknown, issues: string[]): Port[] {
  if (!Array.isArray(value)) { issues.push("proposedTemplate.ports must be an array"); return []; }
  if (value.length > MAX_PORTS) { issues.push(`proposedTemplate.ports exceeds ${MAX_PORTS} entries`); return []; }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`proposedTemplate.ports[${index}] must be an object`);
      return {} as Port;
    }
    const input = raw as Record<string, unknown>;
    const id = string(input.id, `proposedTemplate.ports[${index}].id`, issues, true) ?? "";
    if (id && seen.has(id)) issues.push(`Duplicate port id: ${id}`);
    seen.add(id);
    const label = string(input.label, `proposedTemplate.ports[${index}].label`, issues, true) ?? "";
    const signalType = string(input.signalType, `proposedTemplate.ports[${index}].signalType`, issues, true) ?? "";
    const direction = string(input.direction, `proposedTemplate.ports[${index}].direction`, issues, true) ?? "";
    const connectorType = string(input.connectorType, `proposedTemplate.ports[${index}].connectorType`, issues);
    if (signalType && !SIGNALS.has(signalType)) issues.push(`Unknown signalType: ${signalType}`);
    if (direction && !DIRECTIONS.has(direction)) issues.push(`Unknown direction: ${direction}`);
    if (connectorType && !CONNECTORS.has(connectorType)) issues.push(`Unknown connectorType: ${connectorType}`);
    const section = input.section == null ? undefined : string(input.section, `proposedTemplate.ports[${index}].section`, issues);
    return {
      id, label, signalType: signalType as Port["signalType"], direction: direction as Port["direction"],
      ...(connectorType ? { connectorType: connectorType as Port["connectorType"] } : {}),
      ...(section ? { section } : {}),
    };
  });
}

function validateTemplate(db: DatabaseSync, value: unknown) {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { proposedTemplate: null, issues: ["proposedTemplate must be an object"], taxonomyValidation: [] };
  }
  const input = value as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!CANONICAL_FIELDS.has(field)) issues.push(`Unsupported canonical field: ${field}`);
  const manufacturer = string(input.manufacturer, "proposedTemplate.manufacturer", issues, true) ?? "";
  const modelNumber = string(input.modelNumber, "proposedTemplate.modelNumber", issues, true) ?? "";
  const label = string(input.label, "proposedTemplate.label", issues, true) ?? "";
  const deviceType = string(input.deviceType, "proposedTemplate.deviceType", issues, true) ?? "";
  const category = string(input.category, "proposedTemplate.category", issues, true) ?? "";
  const roleTags = strings(input.roleTags, "proposedTemplate.roleTags", issues);
  const deviceCapabilities = strings(input.deviceCapabilities, "proposedTemplate.deviceCapabilities", issues);
  const protocols = strings(input.protocols, "proposedTemplate.protocols", issues);
  const taxonomyValidation = [
    { kind: "category", values: [category], allowed: effectiveValues(db, "category") },
    { kind: "deviceType", values: [deviceType], allowed: effectiveValues(db, "deviceType") },
    { kind: "roleTag", values: roleTags, allowed: effectiveValues(db, "roleTag") },
    { kind: "deviceCapability", values: deviceCapabilities, allowed: effectiveValues(db, "deviceCapability") },
    { kind: "protocol", values: protocols, allowed: effectiveValues(db, "protocol") },
  ].map(({ kind, values, allowed }) => ({ kind, values, unknownValues: values.filter((entry) => entry && !allowed.has(entry)) }));
  for (const result of taxonomyValidation) for (const unknown of result.unknownValues) issues.push(`Unknown ${result.kind}: ${unknown}`);
  const rackForm = input.rackForm == null ? undefined : string(input.rackForm, "proposedTemplate.rackForm", issues);
  if (rackForm && !RACK_FORMS.has(rackForm)) issues.push(`Unknown rackForm: ${rackForm}`);
  const searchTerms = strings(input.searchTerms, "proposedTemplate.searchTerms", issues);
  const proposedTemplate: DeviceTemplate = {
    manufacturer, modelNumber, label, deviceType, category,
    ports: validatePorts(input.ports, issues),
    ...(string(input.shortName, "proposedTemplate.shortName", issues) ? { shortName: String(input.shortName).trim() } : {}),
    ...(roleTags.length ? { roleTags } : {}),
    ...(deviceCapabilities.length ? { deviceCapabilities } : {}),
    ...(protocols.length ? { protocols } : {}),
    ...(searchTerms.length ? { searchTerms } : {}),
    ...(string(input.referenceUrl, "proposedTemplate.referenceUrl", issues) ? { referenceUrl: String(input.referenceUrl).trim() } : {}),
    ...(positiveNumber(input.heightMm, "proposedTemplate.heightMm", issues) ? { heightMm: input.heightMm as number } : {}),
    ...(positiveNumber(input.widthMm, "proposedTemplate.widthMm", issues) ? { widthMm: input.widthMm as number } : {}),
    ...(positiveNumber(input.depthMm, "proposedTemplate.depthMm", issues) ? { depthMm: input.depthMm as number } : {}),
    ...(positiveNumber(input.weightKg, "proposedTemplate.weightKg", issues) ? { weightKg: input.weightKg as number } : {}),
    ...(rackForm ? { rackForm: rackForm as DeviceTemplate["rackForm"] } : {}),
  };
  return { proposedTemplate, issues, taxonomyValidation };
}

export function createLibraryDoctorNewTemplateProposal(db: DatabaseSync, input: CreateNewTemplateProposalInput) {
  const validation = validateTemplate(db, input.proposedTemplate);
  const aliases = strings(input.identityAliases, "identityAliases", validation.issues);
  const operationalNotes = strings(input.operationalNotes, "operationalNotes", validation.issues);
  if (input.historicalUsageEvidence != null && (typeof input.historicalUsageEvidence !== "object" || Array.isArray(input.historicalUsageEvidence))) {
    validation.issues.push("historicalUsageEvidence must be an object");
  }
  const templates = listCurrentTemplates(db);
  const proposed = validation.proposedTemplate;
  const exactCanonicalCollisions = proposed ? templates.filter((template) =>
    normalize(template.manufacturer ?? "") === normalize(proposed.manufacturer ?? "")
    && [template.modelNumber, template.label].filter(Boolean).some((value) => normalize(value!) === normalize(proposed.modelNumber ?? ""))) : [];
  const aliasKeys = new Set(aliases.map(normalize));
  const exactAliasCollisions = templates.filter((template) => [template.modelNumber, template.label]
    .some((value) => value && aliasKeys.has(normalize(value))));
  const possibleRelatedTemplates = proposed ? templates.filter((template) =>
    normalize(template.manufacturer ?? "") === normalize(proposed.manufacturer ?? ""))
    .slice(0, 25).map((template) => ({ id: template.id, manufacturer: template.manufacturer, modelNumber: template.modelNumber, label: template.label, reason: "same manufacturer" })) : [];
  const searchTerms = new Set((proposed?.searchTerms ?? []).map(normalize));
  const searchTermCollisions = templates.filter((template) => (template.searchTerms ?? []).some((term) => searchTerms.has(normalize(term))))
    .slice(0, 25).map((template) => ({ id: template.id, manufacturer: template.manufacturer, modelNumber: template.modelNumber, label: template.label }));
  if (exactCanonicalCollisions.length) validation.issues.push("Exact canonical manufacturer/model collision");
  const warnings = [
    ...(exactAliasCollisions.length ? ["One or more proposed identity aliases exactly collide with canonical template identities."] : []),
    ...(possibleRelatedTemplates.length ? ["Same-manufacturer templates exist; related-template evidence is non-authoritative."] : []),
    ...(searchTermCollisions.length ? ["Exact search-term overlap is weak evidence only and is not a blocker."] : []),
  ];
  const beforeTemplateCount = templates.length;
  const proposedTemplateSummary = proposed ? {
    manufacturer: proposed.manufacturer,
    modelNumber: proposed.modelNumber,
    label: proposed.label,
    deviceType: proposed.deviceType,
    category: proposed.category,
    portCount: proposed.ports.length,
  } : null;
  const base = {
    success: validation.issues.length === 0,
    readOnly: false,
    proposalOnly: true,
    applied: false,
    validationIssues: validation.issues,
    warnings,
    taxonomyValidation: validation.taxonomyValidation,
    exactCanonicalCollisions: exactCanonicalCollisions.map(({ id, manufacturer, modelNumber, label }) => ({ id, manufacturer, modelNumber, label })),
    exactAliasCollisions: exactAliasCollisions.map(({ id, manufacturer, modelNumber, label }) => ({ id, manufacturer, modelNumber, label })),
    possibleRelatedTemplates,
    searchTermCollisions,
    canonicalTemplateCountBefore: beforeTemplateCount,
    proposedTemplateSummary,
  };
  if (!proposed || validation.issues.length) return { ...base, proposal: null, canonicalTemplateCountAfter: templates.length };
  const confidence = (input.classificationConfidence ?? "medium") as LibraryDoctorConfidence;
  if (!new Set(["low", "medium", "high"]).has(confidence)) return { ...base, success: false, proposal: null, validationIssues: [...validation.issues, "classificationConfidence must be low, medium, or high"], canonicalTemplateCountAfter: templates.length };
  const identity = `${normalize(proposed.manufacturer ?? "")}::${normalize(proposed.modelNumber ?? "")}`;
  const generationKey = typeof input.generationKey === "string" && input.generationKey.trim()
    ? input.generationKey.trim()
    : `new-template:${createHash("sha256").update(identity).digest("hex")}`;
  const existing = getLibraryDoctorProposalByGenerationKey(db, generationKey);
  if (existing) return {
    ...base,
    success: true,
    alreadyExisting: true,
    proposal: existing,
    proposalId: existing.id,
    status: existing.status,
    proposalType: existing.proposalType,
    evidenceCount: existing.evidenceRefs.length,
    canonicalTemplateCountAfter: templates.length,
  };
  const proposal = createLibraryDoctorProposal(db, {
    templateId: `new-template:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    manufacturer: proposed.manufacturer,
    modelNumber: proposed.modelNumber,
    field: "template",
    currentValue: null,
    proposedValue: {
      proposedTemplate: proposed,
      proposalMetadata: {
        identityAliases: aliases,
        historicalUsageEvidence: input.historicalUsageEvidence ?? {},
        operationalNotes,
        duplicateCheck: { exactCanonicalCollisions: [], exactAliasCollisions: base.exactAliasCollisions, possibleRelatedTemplates, searchTermCollisions },
        taxonomyValidation: validation.taxonomyValidation,
      },
    },
    proposalType: "new-template",
    confidence,
    risk: input.risk,
    evidenceRefs: input.evidenceRefs,
    rationale: input.rationale,
    createdBy: input.createdBy,
    supersedesProposalId: input.supersedesProposalId,
    generationKey,
    validatedNewTemplate: true,
  });
  return { ...base, success: true, alreadyExisting: false, proposal, proposalId: proposal.id, status: proposal.status, proposalType: proposal.proposalType, evidenceCount: proposal.evidenceRefs.length, canonicalTemplateCountAfter: listCurrentTemplates(db).length };
}
