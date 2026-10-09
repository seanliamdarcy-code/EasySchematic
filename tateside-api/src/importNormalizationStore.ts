import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate, Port } from "../../src/types.js";
import {
  SIGNAL_LABELS,
  CONNECTOR_LABELS,
} from "../../src/types.js";
import { DEVICE_TYPE_TO_CATEGORY } from "../../src/deviceTypeCategories.js";
import type {
  ImportNormalizationAppliedRule,
  ImportNormalizationDraftRule,
  ImportNormalizationFieldKind,
  ImportNormalizationMetadata,
  ImportNormalizationResolveRequest,
  ImportNormalizationResolution,
  ImportNormalizationRule,
  ImportNormalizationScope,
  ImportNormalizationTrustLevel,
  ImportNormalizationUnresolved,
} from "../../src/importNormalization.js";
import { normalizeImportNormalizationText } from "../../src/importNormalization.js";

interface RuleRow {
  id: string;
  field_kind: ImportNormalizationFieldKind;
  raw_value: string;
  normalized_raw_value: string;
  manufacturer: string | null;
  normalized_manufacturer: string | null;
  model_number: string | null;
  normalized_model_number: string | null;
  canonical_value: string | null;
  custom_definition_id: string | null;
  scope: ImportNormalizationScope;
  trust_level: ImportNormalizationTrustLevel;
  source: string;
  notes: string | null;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

interface SaveRuleInput {
  fieldKind: unknown;
  rawValue: unknown;
  manufacturer?: unknown;
  modelNumber?: unknown;
  canonicalValue: unknown;
  scope: unknown;
  trustLevel?: unknown;
  notes?: unknown;
  actorEmail?: string | null;
  source?: string;
}

interface ResolvedRule extends ImportNormalizationRule {
  precedence: number;
  draftOrder: number;
}

const VALID_SIGNAL_TYPES = new Set(Object.keys(SIGNAL_LABELS));
const VALID_CONNECTOR_TYPES = new Set(Object.keys(CONNECTOR_LABELS));
const VALID_DEVICE_TYPES = new Set(Object.keys(DEVICE_TYPE_TO_CATEGORY));
const VALID_FIELD_KINDS = new Set<ImportNormalizationFieldKind>(["connectorType", "signalType", "deviceType"]);
const VALID_SCOPES = new Set<ImportNormalizationScope>(["model", "manufacturer", "global"]);
const VALID_TRUST_LEVELS = new Set<ImportNormalizationTrustLevel>(["draft", "reviewed", "trusted_standard"]);

function asRule(row: RuleRow): ImportNormalizationRule {
  return {
    id: row.id,
    fieldKind: row.field_kind,
    rawValue: row.raw_value,
    normalizedRawValue: row.normalized_raw_value,
    manufacturer: row.manufacturer ?? undefined,
    normalizedManufacturer: row.normalized_manufacturer ?? undefined,
    modelNumber: row.model_number ?? undefined,
    normalizedModelNumber: row.normalized_model_number ?? undefined,
    canonicalValue: row.canonical_value ?? "",
    scope: row.scope,
    trustLevel: row.trust_level,
    source: row.source,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email,
  };
}

function normalizeScope(scope: ImportNormalizationScope, manufacturer?: string, modelNumber?: string): {
  manufacturer: string | null;
  normalizedManufacturer: string | null;
  modelNumber: string | null;
  normalizedModelNumber: string | null;
} {
  const cleanManufacturer = typeof manufacturer === "string" && manufacturer.trim() ? manufacturer.trim() : null;
  const cleanModelNumber = typeof modelNumber === "string" && modelNumber.trim() ? modelNumber.trim() : null;

  if (scope === "global") {
    return {
      manufacturer: null,
      normalizedManufacturer: null,
      modelNumber: null,
      normalizedModelNumber: null,
    };
  }

  if (!cleanManufacturer) {
    throw new Error("manufacturer is required for manufacturer or model scoped rules");
  }

  if (scope === "manufacturer") {
    return {
      manufacturer: cleanManufacturer,
      normalizedManufacturer: normalizeImportNormalizationText(cleanManufacturer),
      modelNumber: null,
      normalizedModelNumber: null,
    };
  }

  if (!cleanModelNumber) {
    throw new Error("modelNumber is required for model scoped rules");
  }

  return {
    manufacturer: cleanManufacturer,
    normalizedManufacturer: normalizeImportNormalizationText(cleanManufacturer),
    modelNumber: cleanModelNumber,
    normalizedModelNumber: normalizeImportNormalizationText(cleanModelNumber),
  };
}

function validateCanonicalValue(fieldKind: ImportNormalizationFieldKind, canonicalValue: string): string {
  const trimmed = canonicalValue.trim();
  if (!trimmed) {
    throw new Error("canonicalValue is required");
  }

  const valid =
    fieldKind === "connectorType"
      ? VALID_CONNECTOR_TYPES.has(trimmed)
      : fieldKind === "signalType"
        ? VALID_SIGNAL_TYPES.has(trimmed)
        : VALID_DEVICE_TYPES.has(trimmed);

  if (!valid) {
    throw new Error(`canonicalValue "${trimmed}" is not a known ${fieldKind}`);
  }

  return trimmed;
}

function prepareRuleInput(input: SaveRuleInput): {
  fieldKind: ImportNormalizationFieldKind;
  rawValue: string;
  normalizedRawValue: string;
  manufacturer: string | null;
  normalizedManufacturer: string | null;
  modelNumber: string | null;
  normalizedModelNumber: string | null;
  canonicalValue: string;
  scope: ImportNormalizationScope;
  trustLevel: ImportNormalizationTrustLevel;
  notes: string | null;
  source: string;
  actorEmail: string | null;
} {
  const fieldKind = typeof input.fieldKind === "string" ? input.fieldKind as ImportNormalizationFieldKind : null;
  if (!fieldKind || !VALID_FIELD_KINDS.has(fieldKind)) {
    throw new Error("fieldKind must be connectorType, signalType, or deviceType");
  }

  const rawValue = typeof input.rawValue === "string" ? input.rawValue.trim() : "";
  if (!rawValue) {
    throw new Error("rawValue is required");
  }

  const scope = typeof input.scope === "string" ? input.scope as ImportNormalizationScope : null;
  if (!scope || !VALID_SCOPES.has(scope)) {
    throw new Error("scope must be model, manufacturer, or global");
  }

  const trustLevel = typeof input.trustLevel === "string"
    ? input.trustLevel as ImportNormalizationTrustLevel
    : "reviewed";
  if (!VALID_TRUST_LEVELS.has(trustLevel)) {
    throw new Error("trustLevel must be draft, reviewed, or trusted_standard");
  }

  const canonicalValue = validateCanonicalValue(fieldKind, typeof input.canonicalValue === "string" ? input.canonicalValue : "");
  const scoped = normalizeScope(scope, typeof input.manufacturer === "string" ? input.manufacturer : undefined, typeof input.modelNumber === "string" ? input.modelNumber : undefined);

  return {
    fieldKind,
    rawValue,
    normalizedRawValue: normalizeImportNormalizationText(rawValue),
    manufacturer: scoped.manufacturer,
    normalizedManufacturer: scoped.normalizedManufacturer,
    modelNumber: scoped.modelNumber,
    normalizedModelNumber: scoped.normalizedModelNumber,
    canonicalValue,
    scope,
    trustLevel,
    notes: typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null,
    source: input.source ?? "manual",
    actorEmail: input.actorEmail ?? null,
  };
}

function getRuleRowById(db: DatabaseSync, ruleId: string): RuleRow | undefined {
  return db.prepare(`
    SELECT *
    FROM import_normalization_rules
    WHERE id = ?
  `).get(ruleId) as RuleRow | undefined;
}

function listRuleRows(db: DatabaseSync): RuleRow[] {
  return db.prepare(`
    SELECT *
    FROM import_normalization_rules
    ORDER BY
      field_kind,
      normalized_raw_value,
      CASE scope WHEN 'model' THEN 1 WHEN 'manufacturer' THEN 2 ELSE 3 END,
      lower(coalesce(manufacturer, '')),
      lower(coalesce(model_number, '')),
      lower(canonical_value)
  `).all() as unknown as RuleRow[];
}

function writeAuditLog(
  db: DatabaseSync,
  ruleId: string,
  action: "create" | "update" | "delete",
  actorEmail: string | null,
  details: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO import_normalization_rule_audit_log (
      id, rule_id, action, actor_email, details_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    randomUUID(),
    ruleId,
    action,
    actorEmail,
    JSON.stringify(details),
  );
}

function resolveCategoryAfterDeviceTypeNormalization(
  previousDeviceType: string,
  previousCategory: string | undefined,
  canonicalDeviceType: string,
): string | undefined {
  const nextCategory = DEVICE_TYPE_TO_CATEGORY[canonicalDeviceType];
  if (!nextCategory) {
    return previousCategory;
  }

  const trimmedPreviousCategory = previousCategory?.trim();
  const previousDerivedCategory = DEVICE_TYPE_TO_CATEGORY[previousDeviceType];
  const shouldReplace =
    !trimmedPreviousCategory
    || trimmedPreviousCategory === "Uncategorized"
    || (previousDerivedCategory != null && trimmedPreviousCategory === previousDerivedCategory);

  return shouldReplace ? nextCategory : previousCategory;
}

export function listImportNormalizationRules(db: DatabaseSync): ImportNormalizationRule[] {
  return listRuleRows(db).map(asRule);
}

export function createImportNormalizationRule(db: DatabaseSync, input: SaveRuleInput): ImportNormalizationRule {
  const prepared = prepareRuleInput(input);
  const id = randomUUID();

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO import_normalization_rules (
        id,
        field_kind,
        raw_value,
        normalized_raw_value,
        manufacturer,
        normalized_manufacturer,
        model_number,
        normalized_model_number,
        canonical_value,
        custom_definition_id,
        scope,
        trust_level,
        source,
        notes,
        created_at,
        created_by_email,
        updated_at,
        updated_by_email
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), ?)
    `).run(
      id,
      prepared.fieldKind,
      prepared.rawValue,
      prepared.normalizedRawValue,
      prepared.manufacturer,
      prepared.normalizedManufacturer,
      prepared.modelNumber,
      prepared.normalizedModelNumber,
      prepared.canonicalValue,
      prepared.scope,
      prepared.trustLevel,
      prepared.source,
      prepared.notes,
      prepared.actorEmail,
      prepared.actorEmail,
    );

    writeAuditLog(db, id, "create", prepared.actorEmail, {
      fieldKind: prepared.fieldKind,
      rawValue: prepared.rawValue,
      canonicalValue: prepared.canonicalValue,
      scope: prepared.scope,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new Error("A normalization rule already exists for that field/value/scope");
    }
    throw error;
  }

  const saved = getRuleRowById(db, id);
  if (!saved) {
    throw new Error("Could not load saved normalization rule");
  }
  return asRule(saved);
}

export function updateImportNormalizationRule(db: DatabaseSync, ruleId: string, input: SaveRuleInput): ImportNormalizationRule {
  const existing = getRuleRowById(db, ruleId);
  if (!existing) {
    throw new Error("Normalization rule not found");
  }

  const prepared = prepareRuleInput({
    ...input,
    fieldKind: input.fieldKind ?? existing.field_kind,
    rawValue: input.rawValue ?? existing.raw_value,
    manufacturer: input.manufacturer ?? existing.manufacturer ?? undefined,
    modelNumber: input.modelNumber ?? existing.model_number ?? undefined,
    canonicalValue: input.canonicalValue ?? existing.canonical_value ?? undefined,
    scope: input.scope ?? existing.scope,
    trustLevel: input.trustLevel ?? existing.trust_level,
    notes: input.notes ?? existing.notes ?? undefined,
    source: existing.source,
    actorEmail: input.actorEmail,
  });

  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE import_normalization_rules
      SET
        field_kind = ?,
        raw_value = ?,
        normalized_raw_value = ?,
        manufacturer = ?,
        normalized_manufacturer = ?,
        model_number = ?,
        normalized_model_number = ?,
        canonical_value = ?,
        scope = ?,
        trust_level = ?,
        notes = ?,
        updated_at = datetime('now'),
        updated_by_email = ?
      WHERE id = ?
    `).run(
      prepared.fieldKind,
      prepared.rawValue,
      prepared.normalizedRawValue,
      prepared.manufacturer,
      prepared.normalizedManufacturer,
      prepared.modelNumber,
      prepared.normalizedModelNumber,
      prepared.canonicalValue,
      prepared.scope,
      prepared.trustLevel,
      prepared.notes,
      prepared.actorEmail,
      ruleId,
    );

    writeAuditLog(db, ruleId, "update", prepared.actorEmail, {
      before: asRule(existing),
      after: {
        fieldKind: prepared.fieldKind,
        rawValue: prepared.rawValue,
        canonicalValue: prepared.canonicalValue,
        scope: prepared.scope,
      },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new Error("A normalization rule already exists for that field/value/scope");
    }
    throw error;
  }

  const saved = getRuleRowById(db, ruleId);
  if (!saved) {
    throw new Error("Could not load updated normalization rule");
  }
  return asRule(saved);
}

export function deleteImportNormalizationRule(db: DatabaseSync, ruleId: string, actorEmail?: string | null): void {
  const existing = getRuleRowById(db, ruleId);
  if (!existing) {
    throw new Error("Normalization rule not found");
  }

  db.exec("BEGIN");
  try {
    writeAuditLog(db, ruleId, "delete", actorEmail ?? null, {
      deletedRule: asRule(existing),
    });
    db.prepare("DELETE FROM import_normalization_rules WHERE id = ?").run(ruleId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function fieldValueIsKnown(fieldKind: ImportNormalizationFieldKind, value: string): boolean {
  return fieldKind === "connectorType"
    ? VALID_CONNECTOR_TYPES.has(value)
    : fieldKind === "signalType"
      ? VALID_SIGNAL_TYPES.has(value)
      : VALID_DEVICE_TYPES.has(value);
}

function withMetadata(
  existing: ImportNormalizationMetadata | undefined,
  patch: ImportNormalizationMetadata,
): ImportNormalizationMetadata {
  const appliedRuleIds = [
    ...(existing?.appliedRuleIds ?? []),
    ...(patch.appliedRuleIds ?? []),
  ];

  return {
    ...existing,
    ...patch,
    appliedRuleIds: appliedRuleIds.length > 0 ? [...new Set(appliedRuleIds)] : existing?.appliedRuleIds,
  };
}

function appendUnresolved(
  unresolvedMap: Map<string, ImportNormalizationUnresolved>,
  item: ImportNormalizationUnresolved,
): void {
  const key = [
    item.fieldKind,
    normalizeImportNormalizationText(item.rawValue),
    normalizeImportNormalizationText(item.manufacturer),
    normalizeImportNormalizationText(item.modelNumber),
  ].join("|");

  const current = unresolvedMap.get(key);
  if (!current) {
    unresolvedMap.set(key, {
      ...item,
      affectedPorts: [...item.affectedPorts],
    });
    return;
  }

  for (const port of item.affectedPorts) {
    if (!current.affectedPorts.some((existing) => existing.templateLabel === port.templateLabel && existing.portLabel === port.portLabel)) {
      current.affectedPorts.push(port);
    }
  }
}

function resolveCandidateRules(
  savedRules: ImportNormalizationRule[],
  draftRules: ImportNormalizationDraftRule[],
): ResolvedRule[] {
  const normalizedDrafts: ResolvedRule[] = draftRules.map((rule, index) => {
    const scope = rule.scope;
    const scoped = normalizeScope(scope, rule.manufacturer, rule.modelNumber);
    const canonicalValue = validateCanonicalValue(rule.fieldKind, rule.canonicalValue);
    return {
      id: `draft:${index + 1}`,
      fieldKind: rule.fieldKind,
      rawValue: rule.rawValue.trim(),
      normalizedRawValue: normalizeImportNormalizationText(rule.rawValue),
      manufacturer: scoped.manufacturer ?? undefined,
      normalizedManufacturer: scoped.normalizedManufacturer ?? undefined,
      modelNumber: scoped.modelNumber ?? undefined,
      normalizedModelNumber: scoped.normalizedModelNumber ?? undefined,
      canonicalValue,
      scope,
      trustLevel: rule.trustLevel ?? "draft",
      source: "draft",
      notes: undefined,
      createdAt: "",
      createdByEmail: null,
      updatedAt: "",
      updatedByEmail: null,
      precedence: scope === "model" ? 1 : scope === "manufacturer" ? 2 : 3,
      draftOrder: index,
    };
  });

  const persisted = savedRules.map((rule) => ({
    ...rule,
    precedence: rule.scope === "model" ? 1 : rule.scope === "manufacturer" ? 2 : 3,
    draftOrder: Number.MAX_SAFE_INTEGER,
  }));

  return [...normalizedDrafts, ...persisted];
}

function matchRule(
  rules: ResolvedRule[],
  fieldKind: ImportNormalizationFieldKind,
  rawValue: string,
  manufacturer?: string,
  modelNumber?: string,
): ResolvedRule | null {
  const normalizedRawValue = normalizeImportNormalizationText(rawValue);
  const normalizedManufacturer = normalizeImportNormalizationText(manufacturer);
  const normalizedModelNumber = normalizeImportNormalizationText(modelNumber);

  const candidates = rules.filter((rule) => {
    if (rule.fieldKind !== fieldKind) return false;
    if (rule.normalizedRawValue !== normalizedRawValue) return false;
    if (rule.scope === "global") return true;
    if (rule.normalizedManufacturer !== normalizedManufacturer) return false;
    if (rule.scope === "manufacturer") return true;
    return rule.normalizedModelNumber === normalizedModelNumber;
  });

  candidates.sort((a, b) =>
    a.precedence - b.precedence
    || a.draftOrder - b.draftOrder
    || a.updatedAt.localeCompare(b.updatedAt)
    || a.id.localeCompare(b.id));

  return candidates[0] ?? null;
}

function addAppliedRule(
  appliedMap: Map<string, ImportNormalizationAppliedRule>,
  rule: ResolvedRule,
  rawValue: string,
): void {
  const key = `${rule.id}|${rule.fieldKind}|${normalizeImportNormalizationText(rawValue)}`;
  if (appliedMap.has(key)) return;
  appliedMap.set(key, {
    ruleId: rule.id,
    fieldKind: rule.fieldKind,
    rawValue,
    canonicalValue: rule.canonicalValue,
    scope: rule.scope,
  });
}

export function resolveImportNormalization(
  db: DatabaseSync,
  input: ImportNormalizationResolveRequest,
): ImportNormalizationResolution {
  if (!Array.isArray(input.templates)) {
    throw new Error("templates must be an array");
  }

  const savedRules = listImportNormalizationRules(db);
  const allRules = resolveCandidateRules(savedRules, Array.isArray(input.draftRules) ? input.draftRules : []);
  const unresolvedMap = new Map<string, ImportNormalizationUnresolved>();
  const appliedMap = new Map<string, ImportNormalizationAppliedRule>();
  const resolvedAt = new Date().toISOString();

  const templates = input.templates.map((template) => {
    const nextTemplate = structuredClone(template) as DeviceTemplate;
    const manufacturer = nextTemplate.manufacturer;
    const modelNumber = nextTemplate.modelNumber;

    if (typeof nextTemplate.deviceType === "string" && nextTemplate.deviceType.trim()) {
      const deviceTypeRule = matchRule(allRules, "deviceType", nextTemplate.deviceType, manufacturer, modelNumber);
      if (deviceTypeRule) {
        const previousDeviceType = nextTemplate.deviceType;
        addAppliedRule(appliedMap, deviceTypeRule, nextTemplate.deviceType);
        nextTemplate.importNormalization = withMetadata(nextTemplate.importNormalization, {
          rawDeviceType: nextTemplate.deviceType,
          appliedRuleIds: [deviceTypeRule.id],
          resolvedAt,
        });
        nextTemplate.deviceType = deviceTypeRule.canonicalValue;
        nextTemplate.category = resolveCategoryAfterDeviceTypeNormalization(
          previousDeviceType,
          nextTemplate.category,
          deviceTypeRule.canonicalValue,
        );
      } else if (!fieldValueIsKnown("deviceType", nextTemplate.deviceType)) {
        appendUnresolved(unresolvedMap, {
          fieldKind: "deviceType",
          rawValue: nextTemplate.deviceType,
          manufacturer,
          modelNumber,
          affectedPorts: [{ templateLabel: nextTemplate.label }],
        });
      }
    }

    nextTemplate.ports = (nextTemplate.ports ?? []).map((port: Port) => {
      const nextPort = { ...port };

      if (typeof nextPort.signalType === "string" && nextPort.signalType.trim()) {
        const signalRule = matchRule(allRules, "signalType", nextPort.signalType, manufacturer, modelNumber);
        if (signalRule) {
          addAppliedRule(appliedMap, signalRule, nextPort.signalType);
          nextPort.importNormalization = withMetadata(nextPort.importNormalization, {
            rawSignalType: nextPort.signalType,
            appliedRuleIds: [signalRule.id],
            resolvedAt,
          });
          nextPort.signalType = signalRule.canonicalValue as Port["signalType"];
        } else if (!fieldValueIsKnown("signalType", nextPort.signalType)) {
          appendUnresolved(unresolvedMap, {
            fieldKind: "signalType",
            rawValue: nextPort.signalType,
            manufacturer,
            modelNumber,
            affectedPorts: [{ templateLabel: nextTemplate.label, portLabel: nextPort.label }],
          });
        }
      }

      if (typeof nextPort.connectorType === "string" && nextPort.connectorType.trim()) {
        const connectorRule = matchRule(allRules, "connectorType", nextPort.connectorType, manufacturer, modelNumber);
        if (connectorRule) {
          addAppliedRule(appliedMap, connectorRule, nextPort.connectorType);
          nextPort.importNormalization = withMetadata(nextPort.importNormalization, {
            rawConnectorType: nextPort.connectorType,
            appliedRuleIds: [connectorRule.id],
            resolvedAt,
          });
          nextPort.connectorType = connectorRule.canonicalValue as Port["connectorType"];
        } else if (!fieldValueIsKnown("connectorType", nextPort.connectorType)) {
          appendUnresolved(unresolvedMap, {
            fieldKind: "connectorType",
            rawValue: nextPort.connectorType,
            manufacturer,
            modelNumber,
            affectedPorts: [{ templateLabel: nextTemplate.label, portLabel: nextPort.label }],
          });
        }
      }

      return nextPort;
    });

    return nextTemplate;
  });

  return {
    templates,
    appliedRules: [...appliedMap.values()],
    unresolved: [...unresolvedMap.values()].sort((a, b) =>
      a.fieldKind.localeCompare(b.fieldKind)
      || a.rawValue.localeCompare(b.rawValue)
      || (a.manufacturer ?? "").localeCompare(b.manufacturer ?? "")
      || (a.modelNumber ?? "").localeCompare(b.modelNumber ?? "")),
  };
}
