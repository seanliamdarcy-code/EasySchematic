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

export interface LibraryAuditReport {
  totalTemplatesScanned: number;
  totalIssues: number;
  countsBySeverity: Record<LibraryAuditSeverity, number>;
  countsByCode: Partial<Record<LibraryAuditIssueCode, number>>;
  countsByManufacturer: Record<string, number>;
  affectedTemplates: LibraryAuditAffectedTemplate[];
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

function makeReport(templates: DeviceTemplate[], issues: LibraryAuditIssue[]): LibraryAuditReport {
  const countsBySeverity: Record<LibraryAuditSeverity, number> = { error: 0, warning: 0, info: 0 };
  const countsByCode: Partial<Record<LibraryAuditIssueCode, number>> = {};
  const countsByManufacturer: Record<string, number> = {};
  const affected = new Map<string, LibraryAuditAffectedTemplate>();

  for (const issue of issues) {
    countsBySeverity[issue.severity] += 1;
    countsByCode[issue.code] = (countsByCode[issue.code] ?? 0) + 1;
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

  for (const template of templates) {
    const id = templateId(template, templates.indexOf(template));
    const current = affected.get(id);
    if (current) current.label = text(template.label) || null;
  }

  return {
    totalTemplatesScanned: templates.length,
    totalIssues: issues.length,
    countsBySeverity,
    countsByCode,
    countsByManufacturer,
    affectedTemplates: [...affected.values()],
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
