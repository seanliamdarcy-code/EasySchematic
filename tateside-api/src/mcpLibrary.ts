import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeviceTemplate } from "../../src/types.js";
import type { ApiConfig } from "./config.js";
import { listCurrentTemplates } from "./deviceStore.js";
import { auditLibraryTemplates } from "./libraryAudit.js";
import { createLibraryDoctorProposal } from "./libraryDoctorStore.js";
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
      case "preview_taxonomy_registry_change": {
        requireTaxonomy(context);
        const preview = previewTaxonomyRegistryChange(context.db, listCurrentTemplates(context.db), { operation: text(input.operation, "operation", true)!, payload: object(input.payload) });
        return { success: true, ...preview };
      }
      case "create_taxonomy_registry_change_proposal":
        return registryChangeProposal(context, input);
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
  create_library_doctor_proposal: "Create one validated Library Doctor queue proposal for an existing template. This creates a proposal only and never applies or changes the template.",
  preview_taxonomy_registry_change: "Read-only preview of a taxonomy registry change. Returns readOnly true and a deterministic changeKey; never commits registry data.",
  create_taxonomy_registry_change_proposal: "Create a Library Doctor taxonomy-registry-change proposal from a current preview's changeKey. It never commits or applies the registry change.",
};
