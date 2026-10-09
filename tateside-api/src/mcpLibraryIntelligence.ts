import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import { auditLibraryTemplates, type LibraryAuditIssue } from "./libraryAudit.js";
import { listLibraryDoctorProposals } from "./libraryDoctorStore.js";
import { getTaxonomyVocabularies, inspectTemplateTaxonomy, listTaxonomyAliases, previewTemplateTaxonomy } from "./taxonomy.js";
import { builtInDeviceTypeCategory, listRegistryAliases, listRegistryValues, type TaxonomyRegistryKind } from "./taxonomyRegistryStore.js";

type Distribution = Array<{ value: string; count: number }>;
type TaxonomyKind = TaxonomyRegistryKind;

const TAXONOMY_FIELDS: Array<[TaxonomyKind, keyof DeviceTemplate]> = [
  ["category", "category"], ["deviceType", "deviceType"], ["roleTag", "roleTags"], ["deviceCapability", "deviceCapabilities"], ["protocol", "protocols"],
];
const MAX_EXAMPLES = 5;

function value(raw: unknown): string { return typeof raw === "string" ? raw.trim() : ""; }
function key(raw: unknown): string { return value(raw).toLowerCase(); }
function id(template: DeviceTemplate, index = 0): string { return value(template.id) || `${value(template.manufacturer) || "unknown"}:${value(template.modelNumber) || value(template.label) || index + 1}`; }
function templateRef(template: DeviceTemplate, index = 0) {
  return { templateId: id(template, index), manufacturer: value(template.manufacturer) || null, model: value(template.modelNumber) || null, label: value(template.label) || null, category: value(template.category) || null, deviceType: value(template.deviceType) || null };
}
function distribution(values: Iterable<unknown>, max = 25): Distribution {
  const counts = new Map<string, number>();
  for (const item of values) { const normalized = value(item); if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1); }
  return [...counts].map(([item, count]) => ({ value: item, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, max);
}
function arrays(template: DeviceTemplate, field: "roleTags" | "deviceCapabilities" | "protocols"): string[] { return Array.isArray(template[field]) ? template[field].filter((item): item is string => typeof item === "string" && !!item.trim()) : []; }
function portValues(template: DeviceTemplate, field: "connectorType" | "signalType" | "direction"): string[] { return (template.ports ?? []).map((port) => value(port[field])).filter(Boolean); }
function family(template: DeviceTemplate): string {
  const model = value(template.modelNumber) || value(template.label);
  const match = model.toLowerCase().match(/^[a-z]{2,}(?=\d|[-_\s]|$)/);
  return match?.[0] ?? "";
}
function portSignature(template: DeviceTemplate): string {
  return (template.ports ?? []).map((port) => [value(port.direction), value(port.signalType), value(port.connectorType || port.rearConnectorType || port.frontConnectorType)].join(":"))
    .sort().join("|");
}
function issueSummary(issues: LibraryAuditIssue[], templateId: string) {
  const selected = issues.filter((issue) => issue.templateId === templateId);
  return { total: selected.length, error: selected.filter((issue) => issue.severity === "error").length, warning: selected.filter((issue) => issue.severity === "warning").length, info: selected.filter((issue) => issue.severity === "info").length, issues: selected };
}
function isMissingDimension(issue: LibraryAuditIssue): boolean { return issue.code === "MISSING_DIMENSIONS" || issue.code === "MISSING_CATEGORY" || issue.code === "MISSING_DEVICE_TYPE"; }
const REPEATED_PORT_ISSUE_CAP = 3;

function auditIssueSignature(issue: LibraryAuditIssue, index: number): string {
  if (issue.portIndex == null) return `template:${index}`;
  const currentValue = issue.currentValue == null ? "(blank)" : typeof issue.currentValue === "string" ? issue.currentValue.trim().toLowerCase() : JSON.stringify(issue.currentValue);
  return `port:${issue.code}\0${currentValue}`;
}

function weightedAuditIssues(issues: LibraryAuditIssue[], severity: "error" | "warning") {
  const selected = issues.filter((issue) => issue.severity === severity);
  const patterns = new Map<string, number>();
  selected.forEach((issue, index) => {
    const signature = auditIssueSignature(issue, index);
    patterns.set(signature, (patterns.get(signature) ?? 0) + 1);
  });
  const countedCount = [...patterns.values()].reduce((sum, count) => sum + Math.min(count, REPEATED_PORT_ISSUE_CAP), 0);
  return { rawCount: selected.length, countedCount, patternCount: patterns.size, score: countedCount * (severity === "error" ? 10 : 3) };
}

export class LibraryIntelligence {
  readonly audit;
  private readonly registryValues;
  private readonly registryAliases;
  private readonly staticTaxonomy;
  private readonly staticAliases;

  constructor(readonly db: DatabaseSync, readonly templates: DeviceTemplate[]) {
    this.audit = auditLibraryTemplates(templates);
    this.registryValues = listRegistryValues(db);
    this.registryAliases = listRegistryAliases(db);
    this.staticTaxonomy = getTaxonomyVocabularies();
    this.staticAliases = listTaxonomyAliases();
  }

  manufacturerRows(query?: string, minimum = 1) {
    const needle = key(query);
    return [...new Set(this.templates.map((template) => value(template.manufacturer)).filter(Boolean))]
      .filter((manufacturer) => !needle || key(manufacturer).includes(needle))
      .map((manufacturer) => {
        const templates = this.templates.filter((template) => key(template.manufacturer) === key(manufacturer));
        const issues = this.audit.issues.filter((issue) => key(issue.manufacturer) === key(manufacturer));
        const missing = new Set(issues.filter(isMissingDimension).map((issue) => issue.templateId)).size;
        return {
          manufacturer,
          templateCount: templates.length,
          deviceTypeCount: new Set(templates.map((template) => value(template.deviceType)).filter(Boolean)).size,
          categoryCount: new Set(templates.map((template) => value(template.category)).filter(Boolean)).size,
          issueCount: issues.length,
          errorCount: issues.filter((issue) => issue.severity === "error").length,
          warningCount: issues.filter((issue) => issue.severity === "warning").length,
          infoCount: issues.filter((issue) => issue.severity === "info").length,
          missingDimensionCount: missing,
          suspiciousTemplateCount: new Set(issues.filter((issue) => issue.severity === "error" || issue.severity === "warning").map((issue) => issue.templateId)).size,
        };
      }).filter((row) => row.templateCount >= minimum);
  }

  manufacturerSummary(manufacturer: string) {
    const templates = this.templates.filter((template) => key(template.manufacturer) === key(manufacturer));
    if (!templates.length) return null;
    const issues = this.audit.issues.filter((issue) => key(issue.manufacturer) === key(manufacturer));
    const issueCountsByCode = distribution(issues.map((issue) => issue.code));
    const missing = new Set(issues.filter(isMissingDimension).map((issue) => issue.templateId));
    const anomalySignals = this.manufacturerOutliers().filter((row) => key(row.manufacturer) === key(manufacturer)).slice(0, 10);
    return {
      manufacturer: value(templates[0].manufacturer), totalTemplates: templates.length,
      deviceTypeDistribution: distribution(templates.map((template) => template.deviceType)), categoryDistribution: distribution(templates.map((template) => template.category)),
      modelExamples: templates.slice(0, MAX_EXAMPLES).map(templateRef),
      auditIssueCounts: { bySeverity: { error: issues.filter((issue) => issue.severity === "error").length, warning: issues.filter((issue) => issue.severity === "warning").length, info: issues.filter((issue) => issue.severity === "info").length }, byIssueCode: issueCountsByCode },
      completeness: { templatesWithAnyIssue: new Set(issues.map((issue) => issue.templateId)).size, templatesMissingDimensionsOrClassification: missing.size },
      connectorVocabulary: distribution(templates.flatMap((template) => portValues(template, "connectorType"))), signalTypeDistribution: distribution(templates.flatMap((template) => portValues(template, "signalType"))), directionDistribution: distribution(templates.flatMap((template) => portValues(template, "direction"))),
      roleTagsDistribution: distribution(templates.flatMap((template) => arrays(template, "roleTags"))), deviceCapabilitiesDistribution: distribution(templates.flatMap((template) => arrays(template, "deviceCapabilities"))), protocolsDistribution: distribution(templates.flatMap((template) => arrays(template, "protocols"))),
      taxonomyValuesOutsideEffectiveTaxonomy: this.coverageRows(templates).filter((row) => row.taxonomyStatus !== "canonical-active" && row.taxonomyStatus !== "known-alias"),
      anomalySignals, suspiciousTemplateCount: new Set(issues.filter((issue) => issue.severity === "error" || issue.severity === "warning").map((issue) => issue.templateId)).size,
    };
  }

  related(template: DeviceTemplate, strategy = "balanced") {
    const sourceFamily = family(template); const sourcePorts = portSignature(template); const sourceTerms = new Set((template.searchTerms ?? []).map(key).filter(Boolean));
    return this.templates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => id(candidate) !== id(template)).map(({ candidate, index }) => {
      const reasons: string[] = []; let score = 0;
      if (key(candidate.manufacturer) && key(candidate.manufacturer) === key(template.manufacturer)) { reasons.push("same manufacturer"); score += 2; }
      if (sourceFamily.length >= 3 && family(candidate) === sourceFamily) { reasons.push(`shared model family "${sourceFamily}"`); score += 5; }
      if (value(candidate.deviceType) && value(candidate.deviceType) === value(template.deviceType)) { reasons.push("same deviceType"); score += 1; }
      if (value(candidate.category) && value(candidate.category) === value(template.category)) { reasons.push("same category"); score += 1; }
      if (sourcePorts && sourcePorts === portSignature(candidate)) { reasons.push("same normalized port signature"); score += 2; }
      if (sourceTerms.size && (candidate.searchTerms ?? []).map(key).some((term) => sourceTerms.has(term))) { reasons.push("shared search term"); score += 1; }
      return { candidate, index, reasons, score };
    }).filter((row) => row.score > 0 && (strategy !== "family" || row.reasons.some((reason) => reason.startsWith("shared model family"))) && (strategy !== "manufacturer" || row.reasons.includes("same manufacturer")))
      .sort((a, b) => b.score - a.score || value(a.candidate.manufacturer).localeCompare(value(b.candidate.manufacturer)) || value(a.candidate.modelNumber).localeCompare(value(b.candidate.modelNumber)))
      .map(({ candidate, index, reasons, score }) => ({ ...templateRef(candidate, index), relationshipReasons: reasons, matchScore: score, auditIssueCount: issueSummary(this.audit.issues, id(candidate, index)).total, keyDifferences: [value(candidate.deviceType) !== value(template.deviceType) ? "deviceType differs" : "", value(candidate.category) !== value(template.category) ? "category differs" : "", (candidate.ports?.length ?? 0) !== (template.ports?.length ?? 0) ? "port count differs" : ""].filter(Boolean) }));
  }

  taxonomyValue(kind: TaxonomyKind, storedValue: string) {
    const normalized = key(storedValue);
    const dynamic = this.registryValues.filter((row) => row.kind === kind);
    const alias = this.registryAliases.find((row) => row.kind === kind && key(row.aliasValue) === normalized);
    const direct = dynamic.find((row) => key(row.value) === normalized);
    if (direct) return { taxonomyStatus: direct.status === "active" ? "canonical-active" : "deprecated-canonical", knownCanonicalTarget: direct.replacementValue, registryMode: "dynamic" };
    if (alias) return { taxonomyStatus: "known-alias", knownCanonicalTarget: alias.canonicalValue, registryMode: "dynamic" };
    if (dynamic.length) return { taxonomyStatus: "unknown", knownCanonicalTarget: null, registryMode: "dynamic" };
    const staticValues: string[] = kind === "category" ? this.staticTaxonomy.categories : kind === "deviceType" ? this.staticTaxonomy.deviceTypes.map((row) => row.value) : kind === "roleTag" ? this.staticTaxonomy.roleTags : kind === "deviceCapability" ? this.staticTaxonomy.deviceCapabilities : this.staticTaxonomy.protocols;
    if (staticValues.some((item) => key(item) === normalized)) return { taxonomyStatus: "canonical-active", knownCanonicalTarget: null, registryMode: "static-fallback" };
    const field = kind === "roleTag" ? "roleTags" : kind === "deviceCapability" ? "deviceCapabilities" : kind === "protocol" ? "protocols" : kind;
    const staticAlias = this.staticAliases.flatMap((entry) => entry.aliases.concat(entry.deprecatedValues).map((aliasValue) => ({ entry, aliasValue }))).find(({ entry, aliasValue }) => entry.field === field && key(aliasValue) === normalized);
    if (staticAlias) return { taxonomyStatus: "known-alias", knownCanonicalTarget: staticAlias.entry.canonicalValue, registryMode: "static-fallback" };
    return { taxonomyStatus: "unknown", knownCanonicalTarget: null, registryMode: "static-fallback" };
  }

  coverageRows(templates = this.templates) {
    const groups = new Map<string, { kind: TaxonomyKind; storedValue: string; templates: DeviceTemplate[] }>();
    for (const template of templates) for (const [kind, field] of TAXONOMY_FIELDS) {
      const values = Array.isArray(template[field]) ? template[field] : [template[field]];
      for (const storedValue of values) { const item = value(storedValue); if (!item) continue; const groupKey = `${kind}\0${key(item)}`; const group = groups.get(groupKey) ?? { kind, storedValue: item, templates: [] }; group.templates.push(template); groups.set(groupKey, group); }
    }
    return [...groups.values()].map((group) => ({ kind: group.kind, storedValue: group.storedValue, templateCount: group.templates.length, manufacturerCount: new Set(group.templates.map((template) => key(template.manufacturer)).filter(Boolean)).size, exampleTemplates: group.templates.slice(0, MAX_EXAMPLES).map(templateRef), ...this.taxonomyValue(group.kind, group.storedValue) }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.taxonomyStatus.localeCompare(b.taxonomyStatus) || b.templateCount - a.templateCount || a.storedValue.localeCompare(b.storedValue));
  }

  taxonomyConflicts() {
    const conflicts: Array<Record<string, unknown>> = [];
    this.templates.forEach((template, index) => {
      const expectedCategory = this.expectedCategory(template.deviceType);
      if (expectedCategory && value(template.category) && key(expectedCategory) !== key(template.category)) conflicts.push({ conflictType: "deviceType-parent-category-disagreement", strength: 100, affectedTemplates: [templateRef(template, index)], currentStoredValues: { category: template.category, deviceType: template.deviceType }, comparisonBasis: `Effective parent category for deviceType "${template.deviceType}"`, reasonSurfaced: "Stored category differs from the effective taxonomy parent.", evidenceSummary: { expectedCategory }, classification: "deterministic taxonomy conflict" });
      for (const kind of ["category", "deviceType"] as TaxonomyKind[]) {
        const storedValue = value((template as unknown as Record<string, unknown>)[kind]); if (!storedValue) continue; const status = this.taxonomyValue(kind, storedValue);
        if (status.taxonomyStatus === "unknown" || status.taxonomyStatus === "deprecated-canonical") conflicts.push({ conflictType: status.taxonomyStatus === "unknown" ? `${kind}-unknown` : `${kind}-deprecated`, strength: status.taxonomyStatus === "unknown" ? 85 : 70, affectedTemplates: [templateRef(template, index)], currentStoredValues: { [kind]: storedValue }, comparisonBasis: status.registryMode, reasonSurfaced: `Stored ${kind} is ${status.taxonomyStatus}.`, evidenceSummary: status, classification: "deterministic taxonomy conflict" });
      }
    });
    const families = new Map<string, DeviceTemplate[]>();
    for (const template of this.templates) { const f = family(template); if (value(template.manufacturer) && f.length >= 3) { const groupKey = `${key(template.manufacturer)}\0${f}`; families.set(groupKey, [...(families.get(groupKey) ?? []), template]); } }
    for (const [groupKey, templates] of families) {
      const types = distribution(templates.map((template) => template.deviceType)); const categories = distribution(templates.map((template) => template.category));
      if (templates.length >= 2 && types.length > 1) conflicts.push({ conflictType: "manufacturer-family-deviceType-disagreement", strength: 50, affectedTemplates: templates.slice(0, MAX_EXAMPLES).map(templateRef), currentStoredValues: { deviceTypes: types }, comparisonBasis: groupKey, reasonSurfaced: "Templates with the same manufacturer and strong model prefix use different deviceTypes.", evidenceSummary: { family: groupKey.split("\0")[1], templateCount: templates.length }, classification: "statistical anomaly only" });
      if (templates.length >= 2 && categories.length > 1) conflicts.push({ conflictType: "manufacturer-family-category-disagreement", strength: 45, affectedTemplates: templates.slice(0, MAX_EXAMPLES).map(templateRef), currentStoredValues: { categories }, comparisonBasis: groupKey, reasonSurfaced: "Templates with the same manufacturer and strong model prefix use different categories.", evidenceSummary: { family: groupKey.split("\0")[1], templateCount: templates.length }, classification: "statistical anomaly only" });
    }
    return conflicts.concat(this.manufacturerOutliers()).sort((a, b) => Number(b.strength) - Number(a.strength) || String(a.conflictType).localeCompare(String(b.conflictType)));
  }

  manufacturerOutliers() {
    const groups = new Map<string, DeviceTemplate[]>();
    for (const template of this.templates) { const manufacturer = value(template.manufacturer); if (manufacturer) groups.set(key(manufacturer), [...(groups.get(key(manufacturer)) ?? []), template]); }
    const rows: Array<Record<string, unknown>> = [];
    for (const templates of groups.values()) {
      if (templates.length < 5) continue;
      const types = distribution(templates.map((template) => template.deviceType)); const dominant = types[0];
      if (!dominant || dominant.count < 4) continue;
      for (const type of types.slice(1).filter((item) => item.count === 1)) for (const template of templates.filter((item) => value(item.deviceType) === type.value)) rows.push({ conflictType: "manufacturer-deviceType-outlier", strength: 55, manufacturer: value(template.manufacturer), affectedTemplates: [templateRef(template)], currentStoredValues: { deviceType: template.deviceType, category: template.category }, comparisonBasis: { manufacturerTemplateCount: templates.length, dominantDeviceType: dominant }, reasonSurfaced: "A single deviceType differs from the manufacturer's dominant stored deviceType.", evidenceSummary: { outlierDeviceType: type.value }, classification: "statistical anomaly only" });
    }
    return rows;
  }

  suspiciousRows(filters: { manufacturer?: string; category?: string; deviceType?: string; issueCode?: string; severity?: string; limit?: number } = {}) {
    const allConflicts = this.taxonomyConflicts();
    const conflicts = allConflicts.filter((row) => row.conflictType !== "manufacturer-deviceType-outlier");
    const outlierTemplateIds = new Set(allConflicts.filter((row) => row.conflictType === "manufacturer-deviceType-outlier").flatMap((conflict) => (conflict.affectedTemplates as Array<{ templateId: string }>).map((template) => template.templateId)));
    return this.templates.map((template, index) => {
      const templateId = id(template, index); const issues = issueSummary(this.audit.issues, templateId); const reasons: Array<Record<string, unknown>> = [];
      const errors = weightedAuditIssues(issues.issues, "error");
      const warnings = weightedAuditIssues(issues.issues, "warning");
      if (errors.rawCount) reasons.push({ type: "existing audit finding", score: errors.score, detail: `${errors.countedCount} counted audit error(s) from ${errors.rawCount} occurrence(s) across ${errors.patternCount} pattern(s); repeated port patterns capped at ${REPEATED_PORT_ISSUE_CAP}`, rawCount: errors.rawCount, countedCount: errors.countedCount, patternCount: errors.patternCount, perPatternCap: REPEATED_PORT_ISSUE_CAP, formula: `min(count, ${REPEATED_PORT_ISSUE_CAP}) per port pattern × 10` });
      if (warnings.rawCount) reasons.push({ type: "existing audit finding", score: warnings.score, detail: `${warnings.countedCount} counted audit warning(s) from ${warnings.rawCount} occurrence(s) across ${warnings.patternCount} pattern(s); repeated port patterns capped at ${REPEATED_PORT_ISSUE_CAP}`, rawCount: warnings.rawCount, countedCount: warnings.countedCount, patternCount: warnings.patternCount, perPatternCap: REPEATED_PORT_ISSUE_CAP, formula: `min(count, ${REPEATED_PORT_ISSUE_CAP}) per port pattern × 3` });
      const missing = issues.issues.filter(isMissingDimension).length; if (missing) reasons.push({ type: "existing audit finding", score: missing * 2, detail: `${missing} missing dimension/classification finding(s)` });
      for (const kind of ["category", "deviceType"] as TaxonomyKind[]) { const storedValue = value((template as unknown as Record<string, unknown>)[kind]); if (!storedValue) continue; const status = this.taxonomyValue(kind, storedValue); if (status.taxonomyStatus === "unknown") reasons.push({ type: "deterministic taxonomy conflict", score: 8, detail: `Unknown ${kind}: ${storedValue}` }); if (status.taxonomyStatus === "deprecated-canonical") reasons.push({ type: "deterministic taxonomy conflict", score: 4, detail: `Deprecated ${kind}: ${storedValue}` }); }
      if (conflicts.some((conflict) => (conflict.affectedTemplates as Array<{ templateId: string }>).some((item) => item.templateId === templateId))) reasons.push({ type: "deterministic taxonomy conflict", score: 8, detail: "Stored deviceType and category disagree with effective taxonomy." });
      if (outlierTemplateIds.has(templateId)) reasons.push({ type: "anomaly signal", score: 5, detail: "Manufacturer deviceType outlier; inspect, do not assume error." });
      return { ...templateRef(template, index), score: reasons.reduce((sum, reason) => sum + Number(reason.score), 0), scoreBreakdown: reasons, reasons: reasons.map((reason) => reason.detail), errorCount: issues.error, warningCount: issues.warning, infoCount: issues.info, issueCodes: issues.issues.map((issue) => issue.code) };
    }).filter((row) => row.score > 0 && (!filters.manufacturer || key(row.manufacturer) === key(filters.manufacturer)) && (!filters.category || key(row.category) === key(filters.category)) && (!filters.deviceType || key(row.deviceType) === key(filters.deviceType)) && (!filters.issueCode || (row.issueCodes as string[]).includes(filters.issueCode)) && (!filters.severity || (filters.severity === "error" && row.errorCount > 0) || (filters.severity === "warning" && row.warningCount > 0) || (filters.severity === "info" && row.infoCount > 0)))
      .sort((a, b) => b.score - a.score || String(a.manufacturer).localeCompare(String(b.manufacturer)) || String(a.model).localeCompare(String(b.model))).slice(0, filters.limit ?? Number.MAX_SAFE_INTEGER);
  }

  triage(template: DeviceTemplate, index: number, includeProposals: boolean) {
    const templateId = id(template, index); const manufacturer = value(template.manufacturer); const summary = this.manufacturerSummary(manufacturer);
    return {
      template: templateRef(template, index), dimensions: { heightMm: template.heightMm ?? null, widthMm: template.widthMm ?? null, depthMm: template.depthMm ?? null, weightKg: template.weightKg ?? null, rackForm: template.rackForm ?? null }, ports: (template.ports ?? []).slice(0, 50),
      existingAuditIssues: issueSummary(this.audit.issues, templateId), taxonomyPreview: previewTemplateTaxonomy(template), taxonomyStatus: inspectTemplateTaxonomy(template), taxonomyCoverage: ["category", "deviceType"].map((kind) => ({ kind, storedValue: template[kind as "category" | "deviceType"], ...this.taxonomyValue(kind as TaxonomyKind, value(template[kind as "category" | "deviceType"])) })),
      relatedTemplates: this.related(template).slice(0, 10), manufacturerContext: summary ? { totalTemplates: summary.totalTemplates, deviceTypeDistribution: summary.deviceTypeDistribution, categoryDistribution: summary.categoryDistribution } : null,
      classificationConflicts: this.taxonomyConflicts().filter((conflict) => (conflict.affectedTemplates as Array<{ templateId: string }>).some((item) => item.templateId === templateId)).slice(0, 10),
      proposals: includeProposals ? listLibraryDoctorProposals(this.db, { templateId }).map((proposal) => ({ id: proposal.id, status: proposal.status, field: proposal.field, proposalType: proposal.proposalType, createdAt: proposal.createdAt })).slice(0, 25) : [],
      warnings: includeProposals ? [] : ["Library Doctor is disabled; existing proposals were not read."],
    };
  }

  private expectedCategory(deviceType: string): string | undefined {
    const row = this.registryValues.find((value) => value.kind === "deviceType" && key(value.value) === key(deviceType));
    return row?.parentValue ?? builtInDeviceTypeCategory(deviceType);
  }
}
