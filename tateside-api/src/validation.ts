import type {
  DeviceTemplate,
  Port,
  TaxonomyClassificationConfidence,
  TaxonomyEvidenceRef,
  TaxonomyReviewStatus,
} from "../../src/types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_STRING = 500;
const MAX_SEARCH_TERMS = 100;
const MAX_PORTS = 500;
const REVIEW_STATUSES: readonly TaxonomyReviewStatus[] = [
  "imported",
  "ai-researched",
  "needs-review",
  "human-reviewed",
  "trusted-standard",
  "deprecated",
];
const CLASSIFICATION_CONFIDENCES: readonly TaxonomyClassificationConfidence[] = ["low", "medium", "high"];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkString(errors: string[], obj: Record<string, unknown>, key: string, required = false): void {
  const value = obj[key];
  if (value == null) {
    if (required) errors.push(`${key} is required`);
    return;
  }
  if (typeof value !== "string") errors.push(`${key} must be a string`);
  else if (value.length > MAX_STRING) errors.push(`${key} exceeds ${MAX_STRING} characters`);
}

function checkNumber(errors: string[], obj: Record<string, unknown>, key: string): void {
  const value = obj[key];
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`${key} must be a non-negative number`);
  }
}

function checkStringArray(errors: string[], obj: Record<string, unknown>, key: string, maxEntries = MAX_SEARCH_TERMS): void {
  const value = obj[key];
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array`);
    return;
  }
  if (value.length > maxEntries) {
    errors.push(`${key} exceeds ${maxEntries} entries`);
    return;
  }
  if (!value.every((entry) => typeof entry === "string")) {
    errors.push(`${key} must contain only strings`);
  }
}

function checkEnum<T extends string>(errors: string[], obj: Record<string, unknown>, key: string, allowed: readonly T[]): void {
  const value = obj[key];
  if (value == null) return;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${key} must be one of: ${allowed.join(", ")}`);
  }
}

function validateEvidenceRef(value: unknown, index: number, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`evidenceRefs[${index}] must be an object`);
    return;
  }
  checkString(errors, value, "type", true);
  checkString(errors, value, "url");
  checkString(errors, value, "title");
  checkString(errors, value, "excerpt");
  checkString(errors, value, "note");
  checkString(errors, value, "capturedAt");
}

function validatePort(port: unknown, index: number, errors: string[]): void {
  if (!isObject(port)) {
    errors.push(`ports[${index}] must be an object`);
    return;
  }
  checkString(errors, port, "id");
  checkString(errors, port, "label", true);
  checkString(errors, port, "signalType", true);
  checkString(errors, port, "direction", true);
  checkString(errors, port, "connectorType");
  checkString(errors, port, "section");
}

export function validateDeviceTemplate(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ["template must be an object"] };

  checkString(errors, input, "label", true);
  checkString(errors, input, "deviceType", true);
  checkString(errors, input, "manufacturer");
  checkString(errors, input, "modelNumber");
  checkString(errors, input, "category");
  checkString(errors, input, "shortName");
  checkString(errors, input, "referenceUrl");
  checkString(errors, input, "color");
  checkString(errors, input, "slotFamily");
  checkString(errors, input, "lastReviewedBy");
  checkString(errors, input, "lastReviewedAt");
  checkStringArray(errors, input, "roleTags");
  checkStringArray(errors, input, "deviceCapabilities");
  checkStringArray(errors, input, "protocols");
  checkEnum(errors, input, "reviewStatus", REVIEW_STATUSES);
  checkEnum(errors, input, "classificationConfidence", CLASSIFICATION_CONFIDENCES);

  for (const key of [
    "powerDrawW",
    "powerCapacityW",
    "thermalBtuh",
    "poeBudgetW",
    "poeDrawW",
    "unitCost",
    "heightMm",
    "widthMm",
    "depthMm",
    "weightKg",
  ]) {
    checkNumber(errors, input, key);
  }

  if (!Array.isArray(input.ports)) {
    errors.push("ports is required and must be an array");
  } else {
    if (input.ports.length > MAX_PORTS) errors.push(`ports exceeds ${MAX_PORTS} entries`);
    input.ports.forEach((port, index) => validatePort(port, index, errors));
  }

  if (input.searchTerms != null) {
    checkStringArray(errors, input, "searchTerms");
  }

  if (input.evidenceRefs != null) {
    if (!Array.isArray(input.evidenceRefs)) {
      errors.push("evidenceRefs must be an array");
    } else {
      input.evidenceRefs.forEach((entry, index) => validateEvidenceRef(entry, index, errors));
    }
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeDeviceTemplate(input: unknown): Omit<DeviceTemplate, "id" | "version"> {
  if (!isObject(input) || !isString(input.label) || !isString(input.deviceType) || !Array.isArray(input.ports)) {
    throw new Error("Cannot normalize invalid template");
  }

  const template = { ...input } as Omit<DeviceTemplate, "id" | "version">;
  template.label = input.label.trim();
  template.deviceType = input.deviceType.trim();
  template.manufacturer = typeof input.manufacturer === "string" ? input.manufacturer.trim() : undefined;
  template.modelNumber = typeof input.modelNumber === "string" ? input.modelNumber.trim() : undefined;
  template.category = typeof input.category === "string" ? input.category.trim() : undefined;
  template.shortName = typeof input.shortName === "string" ? input.shortName.trim() : undefined;
  template.referenceUrl = typeof input.referenceUrl === "string" ? input.referenceUrl.trim() : undefined;
  template.color = typeof input.color === "string" ? input.color.trim() : undefined;
  template.slotFamily = typeof input.slotFamily === "string" ? input.slotFamily.trim() : undefined;
  template.lastReviewedBy = typeof input.lastReviewedBy === "string" ? input.lastReviewedBy.trim() : undefined;
  template.lastReviewedAt = typeof input.lastReviewedAt === "string" ? input.lastReviewedAt.trim() : undefined;
  template.roleTags = Array.isArray(input.roleTags) ? input.roleTags.map((value) => String(value).trim()).filter(Boolean) : undefined;
  template.deviceCapabilities = Array.isArray(input.deviceCapabilities)
    ? input.deviceCapabilities.map((value) => String(value).trim()).filter(Boolean)
    : undefined;
  template.protocols = Array.isArray(input.protocols) ? input.protocols.map((value) => String(value).trim()).filter(Boolean) : undefined;
  template.reviewStatus = REVIEW_STATUSES.includes(input.reviewStatus as TaxonomyReviewStatus)
    ? input.reviewStatus as TaxonomyReviewStatus
    : undefined;
  template.classificationConfidence = CLASSIFICATION_CONFIDENCES.includes(input.classificationConfidence as TaxonomyClassificationConfidence)
    ? input.classificationConfidence as TaxonomyClassificationConfidence
    : undefined;
  template.evidenceRefs = Array.isArray(input.evidenceRefs)
    ? input.evidenceRefs.map((entry) => {
        const ref = entry as TaxonomyEvidenceRef;
        return {
          type: String(ref.type).trim(),
          url: typeof ref.url === "string" ? ref.url.trim() : undefined,
          title: typeof ref.title === "string" ? ref.title.trim() : undefined,
          excerpt: typeof ref.excerpt === "string" ? ref.excerpt.trim() : undefined,
          note: typeof ref.note === "string" ? ref.note.trim() : undefined,
          capturedAt: typeof ref.capturedAt === "string" ? ref.capturedAt.trim() : undefined,
        };
      })
    : undefined;
  template.ports = (input.ports as Port[]).map((port, index) => ({
    ...port,
    id: port.id || `port-${index + 1}`,
    label: port.label.trim(),
  }));
  return template;
}
