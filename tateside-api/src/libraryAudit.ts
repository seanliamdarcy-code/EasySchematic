import { CONNECTOR_LABELS, SIGNAL_LABELS, type DeviceTemplate, type Port } from "../../src/types.js";

export type LibraryAuditSeverity = "error" | "warning" | "info";

export type LibraryAuditIssueCode =
  | "MISSING_MANUFACTURER"
  | "MISSING_MODEL"
  | "MISSING_NAME"
  | "MISSING_DEVICE_TYPE"
  | "MISSING_CATEGORY"
  | "DUPLICATE_MANUFACTURER_MODEL"
  | "MISSING_DIMENSIONS"
  | "SUSPICIOUS_TEMPLATE_VALUE"
  | "MISSING_PORT_LABEL"
  | "MISSING_PORT_DIRECTION"
  | "INVALID_PORT_DIRECTION"
  | "MISSING_SIGNAL_TYPE"
  | "INVALID_SIGNAL_TYPE"
  | "MISSING_CONNECTOR_TYPE"
  | "INVALID_CONNECTOR_TYPE"
  | "SUSPICIOUS_PORT_VALUE"
  | "DUPLICATE_PORT_LABEL";

export interface LibraryAuditIssue {
  code: LibraryAuditIssueCode;
  severity: LibraryAuditSeverity;
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  portLabel?: string | null;
  portIndex?: number;
  portId?: string;
  currentValue?: unknown;
  message: string;
  suggestion: string;
}

export interface LibraryAuditAffectedTemplate {
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  label: string | null;
  issueCount: number;
}

export interface LibraryAuditHeadline {
  templatesScanned: number;
  totalIssues: number;
  actionableIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  completenessIssueCount: number;
}

export interface LibraryAuditIssueGroup {
  code: LibraryAuditIssueCode;
  severity: LibraryAuditSeverity;
  manufacturer: string | null;
  currentValue: unknown;
  suggestedAction: string;
  issueCount: number;
  affectedTemplateCount: number;
  affectedPortCount: number;
  affectedManufacturers: string[];
  sampleTemplates: LibraryAuditAffectedTemplate[];
}

export interface LibraryAuditTemplateSummary {
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  label: string | null;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  topIssueCodes: Array<{ code: LibraryAuditIssueCode; count: number }>;
  topCurrentValues: Array<{ value: unknown; count: number }>;
}

export interface LibraryAuditCompleteness {
  templatesMissingDimensions: number;
  templatesMissingCategory: number;
  templatesMissingManufacturer: number;
  templatesMissingModel: number;
  templatesMissingDeviceType: number;
}

export interface LibraryAuditReport {
  headline: LibraryAuditHeadline;
  totalTemplatesScanned: number;
  totalIssues: number;
  countsBySeverity: Record<LibraryAuditSeverity, number>;
  countsByCode: Partial<Record<LibraryAuditIssueCode, number>>;
  countsByManufacturer: Record<string, number>;
  affectedTemplates: LibraryAuditAffectedTemplate[];
  issueGroups: LibraryAuditIssueGroup[];
  templateSummaries: LibraryAuditTemplateSummary[];
  completeness: LibraryAuditCompleteness;
  issues: LibraryAuditIssue[];
}

export interface LibraryAuditOptions {
  manufacturer?: string;
  severity?: LibraryAuditSeverity;
  code?: LibraryAuditIssueCode;
}

const DIRECTIONS = new Set(["input", "output", "bidirectional", "passthrough"]);
const SIGNAL_TYPES = new Set(Object.keys(SIGNAL_LABELS));
const CONNECTOR_TYPES = new Set(Object.keys(CONNECTOR_LABELS));
const GENERIC_TEMPLATE_VALUES = new Set(["custom", "unknown", "other", "uncategorized"]);
const GENERIC_SIGNAL_VALUES = new Set(["custom", "unknown", "data", "digital-audio", "network", "other"]);
const GENERIC_CONNECTOR_VALUES = new Set(["custom", "unknown", "data", "digital-audio", "network", "other"]);
const COMPLETENESS_CODES = new Set<LibraryAuditIssueCode>([
  "MISSING_CATEGORY",
  "MISSING_DEVICE_TYPE",
  "MISSING_DIMENSIONS",
  "MISSING_MANUFACTURER",
  "MISSING_MODEL",
]);
const HEADLINE_EXCLUDED_CODES = new Set<LibraryAuditIssueCode>(["MISSING_DIMENSIONS"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function norm(value: unknown): string {
  return text(value).toLowerCase();
}

function templateId(template: DeviceTemplate, index: number): string {
  return text(template.id) || `${text(template.manufacturer) || "unknown"}:${text(template.modelNumber) || text(template.label) || index + 1}`;
}

function templateModel(template: DeviceTemplate): string {
  return text(template.modelNumber) || text((template as { model?: unknown }).model) || text(template.label);
}

function hasAnyDimension(template: DeviceTemplate): boolean {
  return template.heightMm != null
    || template.widthMm != null
    || template.depthMm != null
    || template.weightKg != null
    || template.rackForm != null;
}

function addIssue(
  issues: LibraryAuditIssue[],
  template: DeviceTemplate,
  index: number,
  issue: Omit<LibraryAuditIssue, "templateId" | "manufacturer" | "modelNumber">,
): void {
  issues.push({
    templateId: templateId(template, index),
    manufacturer: text(template.manufacturer) || null,
    modelNumber: templateModel(template) || null,
    ...issue,
  });
}

function valueKey(value: unknown): string {
  return value == null || value === "" ? "(blank)" : String(value);
}

function countValue<T extends string>(record: Partial<Record<T, number>>, key: T): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedCounts<T extends string>(record: Partial<Record<T, number>>): Array<{ key: T; count: number }> {
  return Object.entries(record)
    .map(([key, count]) => ({ key: key as T, count: Number(count) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function suggestedAction(issue: Pick<LibraryAuditIssue, "code" | "currentValue" | "suggestion">): string {
  const value = norm(issue.currentValue);
  if (issue.code === "INVALID_CONNECTOR_TYPE" && value === "euroblock") {
    return "Review connector vocabulary alias; vendor term may need mapping to canonical terminal/phoenix connector type.";
  }
  if (issue.code === "INVALID_PORT_DIRECTION" && value === "inout") {
    return "Likely direction alias for bidirectional; review before adding rule.";
  }
  if (issue.code === "SUSPICIOUS_PORT_VALUE" && (value === "custom" || value === "other")) {
    return "Review whether this is a deliberate logical/pass-through port or an unmapped physical connector/signal.";
  }
  return issue.suggestion;
}

function auditTemplate(template: DeviceTemplate, index: number, issues: LibraryAuditIssue[]): void {
  const label = text(template.label);
  const manufacturer = text(template.manufacturer);
  const model = text(template.modelNumber) || text((template as { model?: unknown }).model);
  const name = text((template as { name?: unknown }).name) || label;
  const deviceType = text(template.deviceType);

  if (!manufacturer) {
    addIssue(issues, template, index, {
      code: "MISSING_MANUFACTURER",
      severity: "warning",
      currentValue: template.manufacturer,
      message: "Template is missing a manufacturer.",
      suggestion: "Add the real manufacturer before using this as a shared library reference.",
    });
  }
  if (!model) {
    addIssue(issues, template, index, {
      code: "MISSING_MODEL",
      severity: "warning",
      currentValue: template.modelNumber,
      message: "Template is missing model/modelNumber metadata.",
      suggestion: "Add modelNumber where available; keep label for the display name.",
    });
  }
  if (!name) {
    addIssue(issues, template, index, {
      code: "MISSING_NAME",
      severity: "error",
      currentValue: template.label,
      message: "Template is missing a label/name.",
      suggestion: "Add a stable device label or name.",
    });
  }
  if (!deviceType) {
    addIssue(issues, template, index, {
      code: "MISSING_DEVICE_TYPE",
      severity: "error",
      currentValue: template.deviceType,
      message: "Template is missing deviceType.",
      suggestion: "Set deviceType to the closest existing library device type.",
    });
  } else if (GENERIC_TEMPLATE_VALUES.has(deviceType.toLowerCase())) {
    addIssue(issues, template, index, {
      code: "SUSPICIOUS_TEMPLATE_VALUE",
      severity: "info",
      currentValue: template.deviceType,
      message: "Template deviceType is generic.",
      suggestion: "Replace generic deviceType values with a more specific type.",
    });
  }

  if ("category" in template && !text(template.category)) {
    addIssue(issues, template, index, {
      code: "MISSING_CATEGORY",
      severity: "info",
      currentValue: template.category,
      message: "Template has an empty category field.",
      suggestion: "Set category or remove the empty field.",
    });
  } else if (GENERIC_TEMPLATE_VALUES.has(norm(template.category))) {
    addIssue(issues, template, index, {
      code: "SUSPICIOUS_TEMPLATE_VALUE",
      severity: "info",
      currentValue: template.category,
      message: "Template category is generic.",
      suggestion: "Use a specific category from the existing library taxonomy.",
    });
  }

  if (!hasAnyDimension(template)) {
    addIssue(issues, template, index, {
      code: "MISSING_DIMENSIONS",
      severity: "info",
      message: "Template has no rack or physical dimension metadata.",
      suggestion: "Add height/width/depth/weight or rackForm when that data is known.",
    });
  }

  for (const field of ["manufacturer", "modelNumber"] as const) {
    const value = norm(template[field]);
    if (GENERIC_TEMPLATE_VALUES.has(value)) {
      addIssue(issues, template, index, {
        code: "SUSPICIOUS_TEMPLATE_VALUE",
        severity: "info",
        currentValue: template[field],
        message: `Template ${field} is generic.`,
        suggestion: `Replace ${field} with a real value or leave it blank for manual review.`,
      });
    }
  }
}

function addPortIssue(
  issues: LibraryAuditIssue[],
  template: DeviceTemplate,
  templateIndex: number,
  port: Port,
  portIndex: number,
  issue: Omit<LibraryAuditIssue, "templateId" | "manufacturer" | "modelNumber" | "portLabel" | "portIndex" | "portId">,
): void {
  addIssue(issues, template, templateIndex, {
    portLabel: text(port.label) || null,
    portIndex,
    portId: text(port.id) || undefined,
    ...issue,
  });
}

function auditConnector(
  issues: LibraryAuditIssue[],
  template: DeviceTemplate,
  templateIndex: number,
  port: Port,
  portIndex: number,
  value: unknown,
  field: "connectorType" | "rearConnectorType" | "frontConnectorType",
): void {
  const connector = text(value);
  if (!connector) return;
  if (!CONNECTOR_TYPES.has(connector)) {
    addPortIssue(issues, template, templateIndex, port, portIndex, {
      code: "INVALID_CONNECTOR_TYPE",
      severity: "error",
      currentValue: connector,
      message: `Port ${field} is not in the canonical connector vocabulary.`,
      suggestion: "Map this connector to an existing connector type before importing or editing templates.",
    });
  } else if (GENERIC_CONNECTOR_VALUES.has(connector.toLowerCase())) {
    addPortIssue(issues, template, templateIndex, port, portIndex, {
      code: "SUSPICIOUS_PORT_VALUE",
      severity: "info",
      currentValue: connector,
      message: `Port ${field} is generic.`,
      suggestion: "Use a specific connector type where possible.",
    });
  }
}

function auditPorts(template: DeviceTemplate, templateIndex: number, issues: LibraryAuditIssue[]): void {
  const labels = new Map<string, number>();
  template.ports?.forEach((port, portIndex) => {
    const label = text(port.label);
    const direction = text(port.direction);
    const signalType = text(port.signalType);

    if (!label) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "MISSING_PORT_LABEL",
        severity: "error",
        currentValue: port.label,
        message: "Port is missing a label.",
        suggestion: "Add the physical or logical port label shown on the device.",
      });
    } else {
      const key = label.toLowerCase();
      const firstIndex = labels.get(key);
      if (firstIndex != null) {
        addPortIssue(issues, template, templateIndex, port, portIndex, {
          code: "DUPLICATE_PORT_LABEL",
          severity: "warning",
          currentValue: label,
          message: `Port label duplicates port ${firstIndex + 1} on the same template.`,
          suggestion: "Make repeated labels unique enough to identify each port safely.",
        });
      } else {
        labels.set(key, portIndex);
      }
    }

    if (!direction) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "MISSING_PORT_DIRECTION",
        severity: "error",
        currentValue: port.direction,
        message: "Port is missing direction.",
        suggestion: "Set direction to input, output, bidirectional, or passthrough.",
      });
    } else if (!DIRECTIONS.has(direction)) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "INVALID_PORT_DIRECTION",
        severity: "error",
        currentValue: direction,
        message: "Port direction is not recognized.",
        suggestion: "Use input, output, bidirectional, or passthrough.",
      });
    }

    if (!signalType) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "MISSING_SIGNAL_TYPE",
        severity: "error",
        currentValue: port.signalType,
        message: "Port is missing signalType.",
        suggestion: "Set signalType to an existing canonical signal type.",
      });
    } else if (!SIGNAL_TYPES.has(signalType)) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "INVALID_SIGNAL_TYPE",
        severity: "error",
        currentValue: signalType,
        message: "Port signalType is not in the canonical signal vocabulary.",
        suggestion: "Map this signal to an existing signal type before importing or editing templates.",
      });
    } else if (GENERIC_SIGNAL_VALUES.has(signalType.toLowerCase())) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "SUSPICIOUS_PORT_VALUE",
        severity: "info",
        currentValue: signalType,
        message: "Port signalType is generic.",
        suggestion: "Use a specific signal type where possible.",
      });
    }

    if (!text(port.connectorType) && !text(port.rearConnectorType) && !text(port.frontConnectorType)) {
      addPortIssue(issues, template, templateIndex, port, portIndex, {
        code: "MISSING_CONNECTOR_TYPE",
        severity: "warning",
        currentValue: port.connectorType,
        message: "Port is missing connectorType.",
        suggestion: "Add connectorType, or rear/front connector types for passthrough ports.",
      });
    }
    auditConnector(issues, template, templateIndex, port, portIndex, port.connectorType, "connectorType");
    auditConnector(issues, template, templateIndex, port, portIndex, port.rearConnectorType, "rearConnectorType");
    auditConnector(issues, template, templateIndex, port, portIndex, port.frontConnectorType, "frontConnectorType");
  });
}

function auditDuplicates(templates: DeviceTemplate[], issues: LibraryAuditIssue[]): void {
  const byKey = new Map<string, number[]>();
  templates.forEach((template, index) => {
    const manufacturer = norm(template.manufacturer);
    const model = norm(templateModel(template));
    if (!manufacturer || !model) return;
    const key = `${manufacturer}:${model}`;
    byKey.set(key, [...(byKey.get(key) ?? []), index]);
  });

  for (const indexes of byKey.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const template = templates[index];
      addIssue(issues, template, index, {
        code: "DUPLICATE_MANUFACTURER_MODEL",
        severity: "warning",
        currentValue: `${text(template.manufacturer)} / ${templateModel(template)}`,
        message: "Another template has the same manufacturer and model/modelNumber.",
        suggestion: "Review duplicates and keep one canonical shared library device where appropriate.",
      });
    }
  }
}

function makeTemplateMap(templates: DeviceTemplate[]): Map<string, LibraryAuditAffectedTemplate> {
  return new Map(templates.map((template, index) => {
    const id = templateId(template, index);
    return [id, {
      templateId: id,
      manufacturer: text(template.manufacturer) || null,
      modelNumber: templateModel(template) || null,
      label: text(template.label) || null,
      issueCount: 0,
    }];
  }));
}

function makeCompleteness(issues: LibraryAuditIssue[]): LibraryAuditCompleteness {
  const idsByCode = new Map<LibraryAuditIssueCode, Set<string>>();
  for (const issue of issues) {
    if (!COMPLETENESS_CODES.has(issue.code)) continue;
    const ids = idsByCode.get(issue.code) ?? new Set<string>();
    ids.add(issue.templateId);
    idsByCode.set(issue.code, ids);
  }

  return {
    templatesMissingDimensions: idsByCode.get("MISSING_DIMENSIONS")?.size ?? 0,
    templatesMissingCategory: idsByCode.get("MISSING_CATEGORY")?.size ?? 0,
    templatesMissingManufacturer: idsByCode.get("MISSING_MANUFACTURER")?.size ?? 0,
    templatesMissingModel: idsByCode.get("MISSING_MODEL")?.size ?? 0,
    templatesMissingDeviceType: idsByCode.get("MISSING_DEVICE_TYPE")?.size ?? 0,
  };
}

function makeIssueGroups(
  issues: LibraryAuditIssue[],
  templatesById: Map<string, LibraryAuditAffectedTemplate>,
): LibraryAuditIssueGroup[] {
  const groups = new Map<string, {
    code: LibraryAuditIssueCode;
    severity: LibraryAuditSeverity;
    manufacturer: string | null;
    currentValue: unknown;
    suggestedAction: string;
    issueCount: number;
    templateIds: Set<string>;
    portIds: Set<string>;
    manufacturers: Set<string>;
  }>();

  for (const issue of issues) {
    const key = [
      issue.code,
      issue.severity,
      issue.manufacturer ?? "",
      valueKey(issue.currentValue),
      suggestedAction(issue),
    ].join("\0");
    const group = groups.get(key) ?? {
      code: issue.code,
      severity: issue.severity,
      manufacturer: issue.manufacturer,
      currentValue: issue.currentValue,
      suggestedAction: suggestedAction(issue),
      issueCount: 0,
      templateIds: new Set<string>(),
      portIds: new Set<string>(),
      manufacturers: new Set<string>(),
    };
    group.issueCount += 1;
    group.templateIds.add(issue.templateId);
    group.manufacturers.add(issue.manufacturer || "Unknown");
    if (issue.portId || issue.portIndex != null) {
      group.portIds.add(`${issue.templateId}:${issue.portId ?? issue.portIndex}`);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      code: group.code,
      severity: group.severity,
      manufacturer: group.manufacturer,
      currentValue: group.currentValue,
      suggestedAction: group.suggestedAction,
      issueCount: group.issueCount,
      affectedTemplateCount: group.templateIds.size,
      affectedPortCount: group.portIds.size,
      affectedManufacturers: [...group.manufacturers].sort(),
      sampleTemplates: [...group.templateIds]
        .map((id) => templatesById.get(id))
        .filter((template): template is LibraryAuditAffectedTemplate => template != null)
        .slice(0, 5),
    }))
    .sort((a, b) => b.issueCount - a.issueCount || a.code.localeCompare(b.code));
}

function makeTemplateSummaries(
  issues: LibraryAuditIssue[],
  templatesById: Map<string, LibraryAuditAffectedTemplate>,
): LibraryAuditTemplateSummary[] {
  const byTemplate = new Map<string, {
    totalIssues: number;
    severity: Record<LibraryAuditSeverity, number>;
    codes: Partial<Record<LibraryAuditIssueCode, number>>;
    values: Record<string, { value: unknown; count: number }>;
  }>();

  for (const issue of issues) {
    const summary = byTemplate.get(issue.templateId) ?? {
      totalIssues: 0,
      severity: { error: 0, warning: 0, info: 0 },
      codes: {},
      values: {},
    };
    summary.totalIssues += 1;
    summary.severity[issue.severity] += 1;
    countValue(summary.codes, issue.code);
    if (issue.currentValue != null && issue.currentValue !== "") {
      const key = valueKey(issue.currentValue);
      summary.values[key] = summary.values[key] ?? { value: issue.currentValue, count: 0 };
      summary.values[key].count += 1;
    }
    byTemplate.set(issue.templateId, summary);
  }

  return [...byTemplate.entries()]
    .map(([id, summary]) => {
      const template = templatesById.get(id);
      return {
        templateId: id,
        manufacturer: template?.manufacturer ?? null,
        modelNumber: template?.modelNumber ?? null,
        label: template?.label ?? null,
        totalIssues: summary.totalIssues,
        errorCount: summary.severity.error,
        warningCount: summary.severity.warning,
        infoCount: summary.severity.info,
        topIssueCodes: sortedCounts(summary.codes)
          .slice(0, 5)
          .map(({ key, count }) => ({ code: key, count })),
        topCurrentValues: Object.values(summary.values)
          .sort((a, b) => b.count - a.count || valueKey(a.value).localeCompare(valueKey(b.value)))
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.totalIssues - a.totalIssues || (a.label ?? "").localeCompare(b.label ?? ""));
}

function makeReport(templates: DeviceTemplate[], issues: LibraryAuditIssue[]): LibraryAuditReport {
  const countsBySeverity: Record<LibraryAuditSeverity, number> = { error: 0, warning: 0, info: 0 };
  const countsByCode: Partial<Record<LibraryAuditIssueCode, number>> = {};
  const countsByManufacturer: Record<string, number> = {};
  const templatesById = makeTemplateMap(templates);
  const affected = new Map<string, LibraryAuditAffectedTemplate>();

  for (const issue of issues) {
    countsBySeverity[issue.severity] += 1;
    countValue(countsByCode, issue.code);
    const manufacturer = issue.manufacturer || "Unknown";
    countsByManufacturer[manufacturer] = (countsByManufacturer[manufacturer] ?? 0) + 1;
    const current = affected.get(issue.templateId) ?? {
      templateId: issue.templateId,
      manufacturer: issue.manufacturer,
      modelNumber: issue.modelNumber,
      label: null,
      issueCount: 0,
    };
    current.issueCount += 1;
    affected.set(issue.templateId, current);
  }

  for (const [id, current] of affected) {
    const template = templatesById.get(id);
    if (template) current.label = template.label;
  }

  const completeness = makeCompleteness(issues);
  const completenessIssueCount = issues.filter((issue) => COMPLETENESS_CODES.has(issue.code)).length;
  const actionableIssues = issues.filter((issue) => !HEADLINE_EXCLUDED_CODES.has(issue.code)).length;

  return {
    headline: {
      templatesScanned: templates.length,
      totalIssues: issues.length,
      actionableIssues,
      errorCount: countsBySeverity.error,
      warningCount: countsBySeverity.warning,
      infoCount: countsBySeverity.info,
      completenessIssueCount,
    },
    totalTemplatesScanned: templates.length,
    totalIssues: issues.length,
    countsBySeverity,
    countsByCode,
    countsByManufacturer,
    affectedTemplates: [...affected.values()],
    issueGroups: makeIssueGroups(issues, templatesById),
    templateSummaries: makeTemplateSummaries(issues, templatesById),
    completeness,
    issues,
  };
}

export function auditLibraryTemplates(templates: DeviceTemplate[], options: LibraryAuditOptions = {}): LibraryAuditReport {
  const manufacturerFilter = norm(options.manufacturer);
  const scopedTemplates = manufacturerFilter
    ? templates.filter((template) => norm(template.manufacturer) === manufacturerFilter)
    : templates;
  const issues: LibraryAuditIssue[] = [];

  scopedTemplates.forEach((template, index) => {
    auditTemplate(template, index, issues);
    auditPorts(template, index, issues);
  });
  auditDuplicates(scopedTemplates, issues);

  const filteredIssues = issues.filter((issue) => {
    if (options.severity && issue.severity !== options.severity) return false;
    if (options.code && issue.code !== options.code) return false;
    return true;
  });

  return makeReport(scopedTemplates, filteredIssues);
}
