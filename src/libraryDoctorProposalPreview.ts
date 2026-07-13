import {
  CONNECTOR_LABELS,
  SIGNAL_LABELS,
  type DeviceData,
  type DeviceTemplate,
  type Port,
  type PortDirection,
} from "./types";

export interface HistoricalUsageEvidence {
  candidateKey?: string;
  occurrences?: number;
  quantity?: number;
  projects?: number;
  rooms?: number;
  completedProjects?: number;
  priorityScore?: number;
}

export interface RelatedTemplateRef {
  id?: string;
  manufacturer?: string;
  modelNumber?: string;
  label?: string;
  reason?: string;
}

export interface DuplicateCheck {
  exactCanonicalCollisions: RelatedTemplateRef[];
  exactAliasCollisions: RelatedTemplateRef[];
  possibleRelatedTemplates: RelatedTemplateRef[];
  searchTermCollisions: RelatedTemplateRef[];
}

export interface TaxonomyValidationResult {
  kind: string;
  values: string[];
  unknownValues: string[];
}

export interface NewTemplateProposalValue {
  proposedTemplate: DeviceTemplate;
  proposalMetadata: {
    identityAliases: string[];
    historicalUsageEvidence: HistoricalUsageEvidence;
    operationalNotes: string[];
    duplicateCheck: DuplicateCheck;
    taxonomyValidation: TaxonomyValidationResult[];
  };
}

export type ParseNewTemplateProposalResult =
  | { ok: true; value: NewTemplateProposalValue }
  | { ok: false; error: string };

export type ProposalPreviewAdapterResult =
  | { ok: true; data: DeviceData }
  | { ok: false; errors: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(source: Record<string, unknown>, key: string, errors: string[], label = key): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

function optionalString(source: Record<string, unknown>, key: string, errors: string[], label = key): string | undefined {
  const value = source[key];
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string when present`);
    return undefined;
  }
  return value.trim();
}

function optionalNumber(source: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = source[key];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`${key} must be a positive number when present`);
    return undefined;
  }
  return value;
}

function strings(value: unknown, key: string, errors: string[]): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push(`${key} must be an array of non-empty strings`);
    return [];
  }
  return value.map((item) => (item as string).trim());
}

function parsePorts(value: unknown, errors: string[]): Port[] {
  if (!Array.isArray(value)) {
    errors.push("ports must be an array");
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((raw, index) => {
    const source = record(raw);
    if (!source) {
      errors.push(`ports[${index}] must be an object`);
      return [];
    }
    const id = requiredString(source, "id", errors, `ports[${index}].id`);
    const label = requiredString(source, "label", errors, `ports[${index}].label`);
    const signalType = requiredString(source, "signalType", errors, `ports[${index}].signalType`);
    const direction = requiredString(source, "direction", errors, `ports[${index}].direction`);
    const connectorType = optionalString(source, "connectorType", errors, `ports[${index}].connectorType`);
    const section = optionalString(source, "section", errors, `ports[${index}].section`);
    if (id && seen.has(id)) errors.push(`ports[${index}].id is duplicated`);
    seen.add(id);
    if (signalType && !(signalType in SIGNAL_LABELS)) errors.push(`ports[${index}].signalType is unknown`);
    if (!(["input", "output", "bidirectional", "passthrough"] as string[]).includes(direction)) {
      errors.push(`ports[${index}].direction is invalid`);
    }
    if (connectorType && !(connectorType in CONNECTOR_LABELS)) {
      errors.push(`ports[${index}].connectorType is unknown`);
    }
    if (!id || !label || !(signalType in SIGNAL_LABELS)
      || !(["input", "output", "bidirectional", "passthrough"] as string[]).includes(direction)
      || (connectorType != null && !(connectorType in CONNECTOR_LABELS))) return [];
    return [{
      id,
      label,
      signalType: signalType as Port["signalType"],
      direction: direction as PortDirection,
      ...(connectorType ? { connectorType: connectorType as Port["connectorType"] } : {}),
      ...(section ? { section } : {}),
    }];
  });
}

function refs(value: unknown): RelatedTemplateRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    if (!source) return [];
    const text = (key: string) => typeof source[key] === "string" ? source[key] as string : undefined;
    return [{ id: text("id"), manufacturer: text("manufacturer"), modelNumber: text("modelNumber"), label: text("label"), reason: text("reason") }];
  });
}

export function parseNewTemplateProposalValue(value: unknown): ParseNewTemplateProposalResult {
  const root = record(value);
  if (!root) return { ok: false, error: "Proposed value is not an object." };
  const rawTemplate = record(root.proposedTemplate);
  if (!rawTemplate) return { ok: false, error: "Proposed value does not contain a proposedTemplate object." };
  const errors: string[] = [];
  const manufacturer = requiredString(rawTemplate, "manufacturer", errors);
  const modelNumber = requiredString(rawTemplate, "modelNumber", errors);
  const label = requiredString(rawTemplate, "label", errors);
  const category = requiredString(rawTemplate, "category", errors);
  const deviceType = requiredString(rawTemplate, "deviceType", errors);
  const ports = parsePorts(rawTemplate.ports, errors);
  const shortName = optionalString(rawTemplate, "shortName", errors);
  const referenceUrl = optionalString(rawTemplate, "referenceUrl", errors);
  const rackForm = optionalString(rawTemplate, "rackForm", errors);
  if (rackForm && !["full", "half", "shelf-only"].includes(rackForm)) errors.push("rackForm is invalid");
  const roleTags = strings(rawTemplate.roleTags, "roleTags", errors);
  const deviceCapabilities = strings(rawTemplate.deviceCapabilities, "deviceCapabilities", errors);
  const protocols = strings(rawTemplate.protocols, "protocols", errors);
  const searchTerms = strings(rawTemplate.searchTerms, "searchTerms", errors);
  const heightMm = optionalNumber(rawTemplate, "heightMm", errors);
  const widthMm = optionalNumber(rawTemplate, "widthMm", errors);
  const depthMm = optionalNumber(rawTemplate, "depthMm", errors);
  const weightKg = optionalNumber(rawTemplate, "weightKg", errors);
  if (errors.length) return { ok: false, error: `Malformed proposed template: ${errors.join("; ")}.` };

  const metadata = record(root.proposalMetadata);
  if (!metadata) return { ok: false, error: "Proposed value does not contain proposalMetadata." };
  const duplicate = record(metadata.duplicateCheck) ?? {};
  const historical = record(metadata.historicalUsageEvidence) ?? {};
  const taxonomyValidation = Array.isArray(metadata.taxonomyValidation)
    ? metadata.taxonomyValidation.flatMap((item) => {
        const source = record(item);
        if (!source || typeof source.kind !== "string") return [];
        return [{
          kind: source.kind,
          values: Array.isArray(source.values) ? source.values.filter((entry): entry is string => typeof entry === "string") : [],
          unknownValues: Array.isArray(source.unknownValues) ? source.unknownValues.filter((entry): entry is string => typeof entry === "string") : [],
        }];
      })
    : [];
  const number = (key: string) => typeof historical[key] === "number" ? historical[key] as number : undefined;
  const template: DeviceTemplate = {
    manufacturer,
    modelNumber,
    label,
    category,
    deviceType,
    ports,
    ...(shortName ? { shortName } : {}),
    ...(referenceUrl ? { referenceUrl } : {}),
    ...(rackForm ? { rackForm: rackForm as DeviceTemplate["rackForm"] } : {}),
    ...(roleTags.length ? { roleTags } : {}),
    ...(deviceCapabilities.length ? { deviceCapabilities } : {}),
    ...(protocols.length ? { protocols } : {}),
    ...(searchTerms.length ? { searchTerms } : {}),
    ...(heightMm != null ? { heightMm } : {}),
    ...(widthMm != null ? { widthMm } : {}),
    ...(depthMm != null ? { depthMm } : {}),
    ...(weightKg != null ? { weightKg } : {}),
  };
  return {
    ok: true,
    value: {
      proposedTemplate: template,
      proposalMetadata: {
        identityAliases: strings(metadata.identityAliases, "identityAliases", []),
        historicalUsageEvidence: {
          ...(typeof historical.candidateKey === "string" ? { candidateKey: historical.candidateKey } : {}),
          ...(number("occurrences") != null ? { occurrences: number("occurrences") } : {}),
          ...(number("quantity") != null ? { quantity: number("quantity") } : {}),
          ...(number("projects") != null ? { projects: number("projects") } : {}),
          ...(number("rooms") != null ? { rooms: number("rooms") } : {}),
          ...(number("completedProjects") != null ? { completedProjects: number("completedProjects") } : {}),
          ...(number("priorityScore") != null ? { priorityScore: number("priorityScore") } : {}),
        },
        operationalNotes: strings(metadata.operationalNotes, "operationalNotes", []),
        duplicateCheck: {
          exactCanonicalCollisions: refs(duplicate.exactCanonicalCollisions),
          exactAliasCollisions: refs(duplicate.exactAliasCollisions),
          possibleRelatedTemplates: refs(duplicate.possibleRelatedTemplates),
          searchTermCollisions: refs(duplicate.searchTermCollisions),
        },
        taxonomyValidation,
      },
    },
  };
}

export function adaptTemplateForProposalPreview(template: DeviceTemplate): ProposalPreviewAdapterResult {
  const errors: string[] = [];
  if (!template.label?.trim()) errors.push("label is required");
  if (!template.deviceType?.trim()) errors.push("deviceType is required");
  if (!Array.isArray(template.ports)) errors.push("ports must be an array");
  else template.ports.forEach((port, index) => {
    if (!port.id || !port.label || !port.signalType || !port.direction) errors.push(`ports[${index}] is invalid`);
  });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      label: template.label,
      deviceType: template.deviceType,
      ports: template.ports.map((port) => ({ ...port })),
      baseLabel: template.label,
      model: template.label,
      auxiliaryData: [{ text: "{{deviceType}}", position: "header" }],
      ...(template.shortName ? { shortName: template.shortName } : {}),
      ...(template.manufacturer ? { manufacturer: template.manufacturer } : {}),
      ...(template.modelNumber ? { modelNumber: template.modelNumber } : {}),
      ...(template.referenceUrl ? { referenceUrl: template.referenceUrl } : {}),
      ...(template.category ? { category: template.category } : {}),
      ...(template.searchTerms?.length ? { searchTerms: [...template.searchTerms] } : {}),
      ...(template.heightMm != null ? { heightMm: template.heightMm } : {}),
      ...(template.widthMm != null ? { widthMm: template.widthMm } : {}),
      ...(template.depthMm != null ? { depthMm: template.depthMm } : {}),
      ...(template.weightKg != null ? { weightKg: template.weightKg } : {}),
      ...(template.rackForm ? { rackForm: template.rackForm } : {}),
    },
  };
}
