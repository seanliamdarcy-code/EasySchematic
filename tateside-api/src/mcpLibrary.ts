import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import type { ApiConfig } from "./config.js";
import { listCurrentTemplates } from "./deviceStore.js";
import {
  getJetbuiltCandidateCooccurrence,
  getJetbuiltCandidateUsage,
  getJetbuiltLibraryCandidate,
  getJetbuiltLibraryCandidates,
  getJetbuiltLibraryCoverageSummary,
} from "./jetbuiltLibraryDiscovery.js";
import { auditLibraryTemplates } from "./libraryAudit.js";
import { createLibraryDoctorProposal } from "./libraryDoctorStore.js";
import { createLibraryDoctorNewTemplateProposal } from "./libraryDoctorNewTemplate.js";
import { LibraryIntelligence } from "./mcpLibraryIntelligence.js";
import { previewTemplateTaxonomy } from "./taxonomy.js";
import {
  getRegistryValue,
  listRegistryAliases,
  listRegistryValues,
  previewTaxonomyRegistryChange,
  type TaxonomyRegistryKind,
} from "./taxonomyRegistryStore.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const KINDS = new Set<TaxonomyRegistryKind>(["category", "deviceType", "roleTag", "deviceCapability", "protocol"]);

export class McpLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpLibraryError";
  }
}

export interface McpLibraryContext {
  db: DatabaseSync;
  config: Pick<ApiConfig, "mcpLibraryEnabled" | "dynamicTaxonomyEnabled" | "libraryAuditEnabled" | "libraryDoctorEnabled">;
  /**
   * Optional separate Jetbuilt history database for read-only discovery tools.
   * Never mutates history, templates, taxonomy, or schematics.
   */
  historyDb?: DatabaseSync | null;
}

function object(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new McpLibraryError("Input must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, required = false): string | undefined {
  if (value == null || value === "") {
    if (required) throw new McpLibraryError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new McpLibraryError(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new McpLibraryError(`${label} is required`);
  if (trimmed.length > 500) throw new McpLibraryError(`${label} exceeds 500 characters`);
  return trimmed || undefined;
}

function limit(value: unknown): number {
  if (value == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > MAX_LIMIT) {
    throw new McpLibraryError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

function offset(value: unknown): number {
  if (value == null) return 0;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 1_000_000) {
    throw new McpLibraryError("offset must be an integer from 0 to 1000000");
  }
  return value;
}

function kind(value: unknown, required = false): TaxonomyRegistryKind | undefined {
  const parsed = text(value, "kind", required);
  if (parsed && !KINDS.has(parsed as TaxonomyRegistryKind)) throw new McpLibraryError("kind is not a supported taxonomy registry kind");
  return parsed as TaxonomyRegistryKind | undefined;
}

function bounded<T>(values: T[], requestedLimit: number, requestedOffset: number) {
  const items = values.slice(requestedOffset, requestedOffset + requestedLimit);
  return { items, count: items.length, total: values.length, limit: requestedLimit, offset: requestedOffset, hasMore: requestedOffset + items.length < values.length };
}

function requireEnabled(context: McpLibraryContext): void {
  if (!context.config.mcpLibraryEnabled) throw new McpLibraryError("MCP library tools are not enabled");
}

function requireTaxonomy(context: McpLibraryContext): void {
  requireEnabled(context);
  if (!context.config.dynamicTaxonomyEnabled) throw new McpLibraryError("Dynamic taxonomy registry is not enabled");
}

function requireAudit(context: McpLibraryContext): void {
  requireEnabled(context);
  if (!context.config.libraryAuditEnabled) throw new McpLibraryError("Library audit is not enabled");
}

function requireDoctor(context: McpLibraryContext): void {
  requireEnabled(context);
  if (!context.config.libraryDoctorEnabled) throw new McpLibraryError("Library Doctor is not enabled");
}

function requireIntelligence(context: McpLibraryContext): void {
  requireAudit(context);
  requireTaxonomy(context);
}

function requireHistoryDiscovery(context: McpLibraryContext): DatabaseSync {
  requireEnabled(context);
  if (!context.historyDb) {
    throw new McpLibraryError("Jetbuilt history discovery is unavailable: history database is not configured");
  }
  return context.historyDb;
}

function optionalBool(value: unknown, label: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new McpLibraryError(`${label} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new McpLibraryError(`${label} must be a number`);
  return value;
}

function templateForId(db: DatabaseSync, id: string): DeviceTemplate {
  const template = listCurrentTemplates(db).find((candidate) => candidate.id === id);
  if (!template) throw new McpLibraryError("Template not found");
  return template;
}

function registryChangeProposal(context: McpLibraryContext, input: Record<string, unknown>) {
  requireTaxonomy(context);
  requireDoctor(context);
  const operation = text(input.operation, "operation", true)!;
  const payload = object(input.payload);
  const suppliedChangeKey = text(input.changeKey, "changeKey", true)!;
  const preview = previewTaxonomyRegistryChange(context.db, listCurrentTemplates(context.db), { operation, payload });
  if (preview.changeKey !== suppliedChangeKey) throw new McpLibraryError("changeKey is stale; preview the registry change again");
  const identifier = createHash("sha256").update(preview.changeKey).digest("hex").slice(0, 24);
  const proposal = createLibraryDoctorProposal(context.db, {
    templateId: `taxonomy-registry:${identifier}`,
    field: "taxonomyRegistry",
    currentValue: preview.current,
    proposedValue: { operation: preview.operation, proposed: preview.proposed, impact: preview.impact, changeKey: preview.changeKey },
    proposalType: "taxonomy-registry-change",
    confidence: "medium",
    risk: "medium",
    rationale: text(input.rationale, "rationale") ?? `Registry change preview: ${preview.operation}`,
    createdBy: text(input.createdBy, "createdBy"),
  });
  return { success: true, proposal, preview, warnings: ["Proposal creation does not commit or apply this registry change."] };
}

export function createMcpLibraryTools(context: McpLibraryContext) {
  const execute = (name: string, rawInput: unknown = {}) => {
    const input = object(rawInput);
    requireEnabled(context);
    switch (name) {
      case "list_taxonomy_values": {
        requireTaxonomy(context);
        const requestedKind = kind(input.kind);
        const values = listRegistryValues(context.db, requestedKind).filter((value) =>
          (!text(input.status, "status") || value.status === text(input.status, "status"))
          && (!text(input.source, "source") || value.source === text(input.source, "source"))
          && (!text(input.parentValue, "parentValue") || value.parentValue === text(input.parentValue, "parentValue")));
        return { success: true, readOnly: true, filtersApplied: input, ...bounded(values, limit(input.limit), offset(input.offset)) };
      }
      case "list_taxonomy_aliases": {
        requireTaxonomy(context);
        const requestedKind = kind(input.kind);
        const aliases = listRegistryAliases(context.db, requestedKind).filter((alias) =>
          (!text(input.status, "status") || alias.status === text(input.status, "status"))
          && (!text(input.canonicalValue, "canonicalValue") || alias.canonicalValue === text(input.canonicalValue, "canonicalValue")));
        return { success: true, readOnly: true, filtersApplied: input, ...bounded(aliases, limit(input.limit), offset(input.offset)) };
      }
      case "get_taxonomy_value":
        requireTaxonomy(context);
        return { success: true, readOnly: true, value: getRegistryValue(context.db, kind(input.kind, true)!, text(input.value, "value", true)!) };
      case "search_templates": {
        const requestedLimit = limit(input.limit);
        const query = text(input.query, "query")?.toLowerCase();
        const filters = ["manufacturer", "model", "name", "category", "deviceType"] as const;
        const templates = listCurrentTemplates(context.db).filter((template) => {
          const candidate = template as DeviceTemplate & { name?: string };
          if (query && ![template.label, template.manufacturer, template.modelNumber, candidate.name, template.category, template.deviceType].some((value) => value?.toLowerCase().includes(query))) return false;
          return filters.every((field) => {
            const expected = text(input[field], field)?.toLowerCase();
            const actual = field === "model" ? template.modelNumber : field === "name" ? (candidate.name ?? template.label) : template[field];
            return !expected || actual?.toLowerCase() === expected;
          });
        });
        return { success: true, readOnly: true, filtersApplied: input, ...bounded(templates, requestedLimit, offset(input.offset)) };
      }
      case "get_template":
        return { success: true, readOnly: true, template: templateForId(context.db, text(input.id, "id", true)!) };
      case "get_template_issues": {
        requireAudit(context);
        const template = templateForId(context.db, text(input.id, "id", true)!);
        const requestedLimit = limit(input.limit);
        const report = auditLibraryTemplates([template]);
        return { success: true, readOnly: true, templateId: template.id, ...bounded(report.issues, requestedLimit, offset(input.offset)), summary: report.headline };
      }
      case "get_library_audit": {
        requireAudit(context);
        const requestedLimit = limit(input.limit);
        const report = auditLibraryTemplates(listCurrentTemplates(context.db), {
          manufacturer: text(input.manufacturer, "manufacturer"), severity: text(input.severity, "severity"), code: text(input.code, "code"), currentValue: text(input.currentValue, "currentValue"), templateId: text(input.templateId, "templateId"),
        });
        return { success: true, readOnly: true, ...bounded(report.issues, requestedLimit, offset(input.offset)), headline: report.headline, countsBySeverity: report.countsBySeverity, countsByCode: report.countsByCode, completeness: report.completeness, filtersApplied: report.filtersApplied };
      }
      case "preview_template_taxonomy": {
        const template = templateForId(context.db, text(input.id, "id", true)!);
        return { success: true, readOnly: true, templateId: template.id, preview: previewTemplateTaxonomy(template) };
      }
      case "get_library_coverage": {
        requireAudit(context);
        const templates = listCurrentTemplates(context.db);
        const audit = auditLibraryTemplates(templates);
        return { success: true, readOnly: true, totalTemplates: templates.length, manufacturers: new Set(templates.map((template) => template.manufacturer).filter(Boolean)).size, categories: new Set(templates.map((template) => template.category).filter(Boolean)).size, deviceTypes: new Set(templates.map((template) => template.deviceType).filter(Boolean)).size, issueCounts: audit.countsBySeverity, completeness: audit.completeness };
      }
      case "list_manufacturers": {
        requireIntelligence(context);
        const requestedLimit = limit(input.limit);
        const sort = text(input.sort, "sort") ?? "name";
        if (!new Set(["name", "templateCount", "issueCount", "errorCount"]).has(sort)) throw new McpLibraryError("sort must be name, templateCount, issueCount, or errorCount");
        const minimumTemplateCount = input.minimumTemplateCount == null ? 1 : limit(input.minimumTemplateCount);
        const rows = new LibraryIntelligence(context.db, listCurrentTemplates(context.db)).manufacturerRows(text(input.query, "query"), minimumTemplateCount)
          .sort((a, b) => sort === "name" ? a.manufacturer.localeCompare(b.manufacturer) : (sort === "templateCount" ? b.templateCount - a.templateCount : sort === "issueCount" ? b.issueCount - a.issueCount : b.errorCount - a.errorCount) || a.manufacturer.localeCompare(b.manufacturer));
        return { success: true, readOnly: true, filtersApplied: input, ...bounded(rows, requestedLimit, offset(input.offset)) };
      }
      case "get_manufacturer_summary": {
        requireIntelligence(context);
        const summary = new LibraryIntelligence(context.db, listCurrentTemplates(context.db)).manufacturerSummary(text(input.manufacturer, "manufacturer", true)!);
        if (!summary) throw new McpLibraryError("Manufacturer not found");
        return { success: true, readOnly: true, ...summary };
      }
      case "find_related_templates": {
        requireIntelligence(context);
        const strategy = text(input.strategy, "strategy") ?? "balanced";
        if (!new Set(["balanced", "family", "manufacturer"]).has(strategy)) throw new McpLibraryError("strategy must be balanced, family, or manufacturer");
        const templates = listCurrentTemplates(context.db); const source = templateForId(context.db, text(input.templateId, "templateId", true)!);
        const matches = new LibraryIntelligence(context.db, templates).related(source, strategy);
        return { success: true, readOnly: true, templateId: source.id, strategy, scoring: "same manufacturer +2; shared model family +5; same deviceType +1; same category +1; same port signature +2; shared search term +1", ...bounded(matches, limit(input.limit), offset(input.offset)) };
      }
      case "get_classification_conflicts": {
        requireIntelligence(context);
        const intelligence = new LibraryIntelligence(context.db, listCurrentTemplates(context.db));
        const requestedType = text(input.conflictType, "conflictType");
        const requestedManufacturer = text(input.manufacturer, "manufacturer");
        const minimumStrength = input.minimumStrength == null ? 0 : limit(input.minimumStrength);
        const rows = intelligence.taxonomyConflicts().filter((row) => (!requestedType || row.conflictType === requestedType) && (!requestedManufacturer || (row.affectedTemplates as Array<{ manufacturer: string | null }>).some((template) => template.manufacturer?.toLowerCase() === requestedManufacturer.toLowerCase())) && Number(row.strength) >= minimumStrength);
        return { success: true, readOnly: true, filtersApplied: input, ...bounded(rows, limit(input.limit), offset(input.offset)) };
      }
      case "get_library_issue_clusters": {
        requireAudit(context);
        const grouping = text(input.grouping, "grouping") ?? "issueCode";
        const supported = new Set(["issueCode", "manufacturer", "currentValue", "connectorType", "signalType", "direction", "category", "deviceType", "manufacturer+issueCode", "issueCode+currentValue"]);
        if (!supported.has(grouping)) throw new McpLibraryError("grouping is not supported");
        const templates = listCurrentTemplates(context.db); const report = auditLibraryTemplates(templates); const byId = new Map(templates.map((template, index) => [template.id ?? `${template.manufacturer}:${template.modelNumber ?? template.label}:${index}`, template]));
        const groupValue = (issue: typeof report.issues[number]) => {
          const template = byId.get(issue.templateId); const port = template?.ports?.[issue.portIndex ?? -1];
          const single: Record<string, unknown> = { issueCode: issue.code, manufacturer: issue.manufacturer, currentValue: issue.currentValue, connectorType: port?.connectorType, signalType: port?.signalType, direction: port?.direction, category: template?.category, deviceType: template?.deviceType };
          return grouping.includes("+") ? grouping.split("+").map((part) => String(single[part] ?? "(blank)")).join(" | ") : String(single[grouping] ?? "(blank)");
        };
        const groups = new Map<string, typeof report.issues>();
        for (const issue of report.issues) { const group = groupValue(issue); groups.set(group, [...(groups.get(group) ?? []), issue]); }
        const rows = [...groups].map(([clusterKey, issues]) => ({ clusterKey, issueCount: issues.length, affectedTemplateCount: new Set(issues.map((issue) => issue.templateId)).size, affectedManufacturerCount: new Set(issues.map((issue) => issue.manufacturer).filter(Boolean)).size, severityDistribution: { error: issues.filter((issue) => issue.severity === "error").length, warning: issues.filter((issue) => issue.severity === "warning").length, info: issues.filter((issue) => issue.severity === "info").length }, exampleTemplates: [...new Set(issues.map((issue) => issue.templateId))].slice(0, 5).map((templateId) => ({ templateId, manufacturer: byId.get(templateId)?.manufacturer ?? null, model: byId.get(templateId)?.modelNumber ?? null, label: byId.get(templateId)?.label ?? null })), exampleCurrentValues: [...new Set(issues.map((issue) => issue.currentValue == null ? "(blank)" : String(issue.currentValue)))].slice(0, 5), knownCanonicalMapping: null }))
          .sort((a, b) => b.issueCount - a.issueCount || a.clusterKey.localeCompare(b.clusterKey));
        return { success: true, readOnly: true, grouping, ...bounded(rows, limit(input.limit), offset(input.offset)) };
      }
      case "get_taxonomy_coverage_gaps": {
        requireIntelligence(context);
        const requestedKind = kind(input.kind);
        const rows = new LibraryIntelligence(context.db, listCurrentTemplates(context.db)).coverageRows().filter((row) => !requestedKind || row.kind === requestedKind);
        return { success: true, readOnly: true, registryAvailability: "Dynamic registry may be empty; static fallback is used where defined by the existing taxonomy.", filtersApplied: input, ...bounded(rows, limit(input.limit), offset(input.offset)) };
      }
      case "get_suspicious_templates": {
        requireIntelligence(context);
        const rows = new LibraryIntelligence(context.db, listCurrentTemplates(context.db)).suspiciousRows({ manufacturer: text(input.manufacturer, "manufacturer"), category: text(input.category, "category"), deviceType: text(input.deviceType, "deviceType"), issueCode: text(input.issueCode, "issueCode"), severity: text(input.severity, "severity") });
        return { success: true, readOnly: true, scoring: "per severity: sum(min(count, 3) per repeated port issue pattern) ×10 for errors or ×3 for warnings; template-level findings count individually; missing dimensions/classification ×2; unknown taxonomy ×8; deprecated taxonomy ×4; deterministic parent conflict +8; manufacturer outlier +5", filtersApplied: input, ...bounded(rows, limit(input.limit), offset(input.offset)) };
      }
      case "get_template_triage_bundle": {
        requireIntelligence(context);
        const templates = listCurrentTemplates(context.db); const templateId = text(input.templateId, "templateId", true)!; const template = templateForId(context.db, templateId); const index = templates.findIndex((candidate) => candidate.id === template.id);
        return { success: true, readOnly: true, ...new LibraryIntelligence(context.db, templates).triage(template, index, context.config.libraryDoctorEnabled) };
      }
      case "create_library_doctor_proposal": {
        requireDoctor(context);
        const template = templateForId(context.db, text(input.templateId, "templateId", true)!);
        const field = text(input.field, "field", true)!;
        const storedCurrentValue = Object.hasOwn(template, field) ? (template as unknown as Record<string, unknown>)[field] : undefined;
        if (storedCurrentValue !== undefined && input.currentValue !== undefined && JSON.stringify(input.currentValue) !== JSON.stringify(storedCurrentValue)) {
          throw new McpLibraryError("currentValue is stale; reload the template before creating a proposal");
        }
        const proposal = createLibraryDoctorProposal(context.db, {
          ...input,
          templateId: template.id,
          manufacturer: template.manufacturer,
          modelNumber: template.modelNumber,
          field,
          currentValue: storedCurrentValue ?? input.currentValue,
          createdBy: text(input.createdBy, "createdBy"),
        } as Parameters<typeof createLibraryDoctorProposal>[1]);
        return { success: true, readOnly: false, proposal, warnings: ["Proposal created only; source template was not modified."] };
      }
      case "create_library_doctor_new_template_proposal":
        requireDoctor(context);
        requireTaxonomy(context);
        return createLibraryDoctorNewTemplateProposal(context.db, {
          ...input,
          createdBy: input.createdBy == null ? undefined : text(input.createdBy, "createdBy"),
          supersedesProposalId: input.supersedesProposalId == null ? undefined : text(input.supersedesProposalId, "supersedesProposalId"),
          generationKey: input.generationKey == null ? undefined : text(input.generationKey, "generationKey"),
        } as Parameters<typeof createLibraryDoctorNewTemplateProposal>[1]);
      case "preview_taxonomy_registry_change": {
        requireTaxonomy(context);
        const preview = previewTaxonomyRegistryChange(context.db, listCurrentTemplates(context.db), { operation: text(input.operation, "operation", true)!, payload: object(input.payload) });
        return { success: true, ...preview };
      }
      case "create_taxonomy_registry_change_proposal":
        return registryChangeProposal(context, input);
      case "get_jetbuilt_library_coverage_summary": {
        const historyDb = requireHistoryDiscovery(context);
        return {
          success: true,
          readOnly: true,
          ...getJetbuiltLibraryCoverageSummary(historyDb, {
            cohort: text(input.cohort, "cohort") as never,
            stage: text(input.stage, "stage"),
            manufacturer: text(input.manufacturer, "manufacturer"),
            from: text(input.from, "from"),
            to: text(input.to, "to"),
            dateBasis: text(input.dateBasis, "dateBasis") as "created" | "updated" | undefined,
          }),
          warnings: ["Historical frequency is triage evidence only and is not canonical device truth."],
        };
      }
      case "get_jetbuilt_library_candidates": {
        const historyDb = requireHistoryDiscovery(context);
        return {
          success: true,
          readOnly: true,
          ...getJetbuiltLibraryCandidates(historyDb, {
            cohort: text(input.cohort, "cohort") as never,
            stage: text(input.stage, "stage"),
            manufacturer: text(input.manufacturer, "manufacturer"),
            from: text(input.from, "from"),
            to: text(input.to, "to"),
            dateBasis: text(input.dateBasis, "dateBasis") as "created" | "updated" | undefined,
            limit: limit(input.limit),
            offset: offset(input.offset),
            minimumProjectCount: optionalNumber(input.minimumProjectCount, "minimumProjectCount"),
            minimumRoomCount: optionalNumber(input.minimumRoomCount, "minimumRoomCount"),
            minimumDeliveredOrInstalledProjectCount: optionalNumber(input.minimumDeliveredOrInstalledProjectCount, "minimumDeliveredOrInstalledProjectCount"),
            excludeKnownNonSchematic: optionalBool(input.excludeKnownNonSchematic, "excludeKnownNonSchematic"),
            exactCanonicalMatch: optionalBool(input.exactCanonicalMatch, "exactCanonicalMatch"),
            minimumPriorityScore: optionalNumber(input.minimumPriorityScore, "minimumPriorityScore"),
          }),
          warnings: [
            "Candidates are deterministic historical triage only.",
            "Does not create templates, aliases, or Library Doctor proposals.",
          ],
        };
      }
      case "get_jetbuilt_library_candidate": {
        const historyDb = requireHistoryDiscovery(context);
        const candidateKey = text(input.candidateKey, "candidateKey");
        const manufacturer = text(input.manufacturer, "manufacturer");
        const model = text(input.model, "model");
        if (!candidateKey && !(manufacturer && model)) throw new McpLibraryError("candidateKey or manufacturer+model is required");
        return {
          success: true,
          readOnly: true,
          ...getJetbuiltLibraryCandidate(
            historyDb,
            candidateKey ?? manufacturer!,
            candidateKey ? undefined : model,
            { canonicalDb: context.db },
          ),
        };
      }
      case "get_jetbuilt_candidate_usage": {
        const historyDb = requireHistoryDiscovery(context);
        const candidateKey = text(input.candidateKey, "candidateKey");
        const manufacturer = text(input.manufacturer, "manufacturer");
        const model = text(input.model, "model");
        if (!candidateKey && !(manufacturer && model)) throw new McpLibraryError("candidateKey or manufacturer+model is required");
        return {
          success: true,
          readOnly: true,
          ...getJetbuiltCandidateUsage(historyDb, candidateKey ?? manufacturer!, candidateKey ? undefined : model),
        };
      }
      case "get_jetbuilt_candidate_cooccurrence": {
        const historyDb = requireHistoryDiscovery(context);
        return {
          success: true,
          readOnly: true,
          ...getJetbuiltCandidateCooccurrence(historyDb, {
            candidateKey: text(input.candidateKey, "candidateKey"),
            manufacturer: text(input.manufacturer, "manufacturer"),
            model: text(input.model, "model"),
            cohort: text(input.cohort, "cohort") as never,
            stage: text(input.stage, "stage"),
            from: text(input.from, "from"),
            to: text(input.to, "to"),
            limit: limit(input.limit),
            offset: offset(input.offset),
            minimumRoomCount: optionalNumber(input.minimumRoomCount, "minimumRoomCount"),
          }),
        };
      }
      default:
        throw new McpLibraryError(`Unknown MCP tool: ${name}`);
    }
  };
  return { execute };
}

export const MCP_LIBRARY_TOOL_DESCRIPTIONS: Record<string, string> = {
  list_taxonomy_values: "Read bounded canonical taxonomy registry values. Filters: kind, status, source, parentValue, limit (default 25; max 100), offset (default 0). Never writes.",
  list_taxonomy_aliases: "Read bounded taxonomy registry aliases. Filters: kind, status, canonicalValue, limit (default 25; max 100), offset (default 0). Never writes.",
  get_taxonomy_value: "Read one canonical taxonomy registry value by kind and value. Never writes.",
  search_templates: "Read a bounded list of current device templates. Filters: manufacturer, model, name, category, deviceType, query, limit (default 25; max 100), offset (default 0). Never writes.",
  get_template: "Read one current template by id, including its stored classification, ports, dimensions, metadata, and review fields. Never writes.",
  get_template_issues: "Read bounded Library Audit issues for one current template by id. Inputs: id, limit (default 25; max 100), offset (default 0). Never writes.",
  get_library_audit: "Read a bounded Library Audit query. Filters: manufacturer, severity, code, currentValue, templateId, limit, offset. Use a specific filter for drill-down; never writes.",
  preview_template_taxonomy: "Read-only taxonomy inference preview for one current template. It never changes the template.",
  get_library_coverage: "Read high-level library coverage and audit completeness counts. Never writes.",
  list_manufacturers: "Read paginated manufacturer coverage and audit counts. Filters: query, minimumTemplateCount; sort: name, templateCount, issueCount, errorCount. Never writes.",
  get_manufacturer_summary: "Read bounded deterministic distributions, audit counts, taxonomy gaps, and clearly labelled anomaly signals for one exact manufacturer. Never writes.",
  find_related_templates: "Read deterministic related templates for one template. Strategies: balanced, family, manufacturer. Returns documented score reasons; never writes.",
  get_classification_conflicts: "Read deterministic taxonomy conflicts and clearly labelled statistical anomaly signals. Filters: manufacturer, conflictType, minimumStrength. Never writes.",
  get_library_issue_clusters: "Read bounded Library Audit issue clusters. Grouping is limited to documented modes; never writes.",
  get_taxonomy_coverage_gaps: "Read stored taxonomy values against the effective dynamic registry or existing static fallback. Never writes or seeds registry data.",
  get_suspicious_templates: "Read a deterministic, explainable triage ranking based on audit findings, taxonomy conflicts, and labelled anomaly signals. Never writes.",
  get_template_triage_bundle: "Read a bounded template, audit, taxonomy, related-template, manufacturer, conflict, and proposal-status bundle. Never writes.",
  create_library_doctor_proposal: "Create one validated Library Doctor queue proposal for an existing template. This creates a proposal only and never applies or changes the template.",
  create_library_doctor_new_template_proposal: "Create one validated whole-new-template Library Doctor proposal. Proposal-only: never creates or applies a canonical template, alias, taxonomy value, schematic change, or Jetbuilt write.",
  preview_taxonomy_registry_change: "Read-only preview of a taxonomy registry change. Returns readOnly true and a deterministic changeKey; never commits registry data.",
  create_taxonomy_registry_change_proposal: "Create a Library Doctor taxonomy-registry-change proposal from a current preview's changeKey. It never commits or applies the registry change.",
  get_jetbuilt_library_coverage_summary: "Read Jetbuilt historical library-discovery coverage summary from the configured history database. Defaults exclude nothing here; use candidates for ranked triage. Never writes, never backfills, never mutates templates/taxonomy/schematics.",
  get_jetbuilt_library_candidates: "Read ranked unmatched Jetbuilt historical device candidates (default excludes known non-schematic and exact matches). Filters: cohort, stage, manufacturer, dates, minimum project/room/delivered counts, excludeKnownNonSchematic, exactCanonicalMatch, priority threshold, limit/offset. Quantity does not dominate ranking. Never writes.",
  get_jetbuilt_library_candidate: "Read one Jetbuilt discovery candidate evidence bundle with usage, co-occurrence, and non-authoritative possible related canonical templates. Inputs: candidateKey or manufacturer+model. Never writes or auto-links.",
  get_jetbuilt_candidate_usage: "Read stage/cohort/time usage for one Jetbuilt discovery candidate. Distinguishes projects, rooms, and line occurrences. Never writes.",
  get_jetbuilt_candidate_cooccurrence: "Read what commonly appears in the same rooms as one Jetbuilt discovery candidate. Distinguishes line occurrences, distinct rooms, and distinct projects. Never writes.",
};
