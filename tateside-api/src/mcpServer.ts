import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getConfig } from "./config.js";
import { assertMigrationsApplied, openDatabase } from "./db.js";
import { openJetbuiltHistoryDatabase, runJetbuiltHistoryMigrations } from "./jetbuiltHistoryStore.js";
import { createMcpLibraryTools, MCP_LIBRARY_TOOL_DESCRIPTIONS, McpLibraryError, type McpLibraryContext } from "./mcpLibrary.js";

const common = {
  kind: z.string().optional(), status: z.string().optional(), source: z.string().optional(), parentValue: z.string().optional(), canonicalValue: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
};
const templateSearch = {
  manufacturer: z.string().optional(), model: z.string().optional(), name: z.string().optional(), category: z.string().optional(), deviceType: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
};

const nonNegativeInteger = z.number().int().min(0);
const nullableString = z.string().nullable();
const openObject = z.object({}).passthrough();
const openRecord = z.record(z.string(), z.unknown());
const warnings = z.array(z.string());
const successfulOutput = (shape: z.ZodRawShape = {}) => z.object({ success: z.literal(true), ...shape }).passthrough();
const readOutput = (shape: z.ZodRawShape = {}) => successfulOutput({ readOnly: z.literal(true), ...shape });
const boundedOutput = (item: z.ZodTypeAny, shape: z.ZodRawShape = {}) => readOutput({
  ...shape,
  items: z.array(item),
  count: nonNegativeInteger,
  total: nonNegativeInteger,
  limit: z.number().int().min(1),
  offset: nonNegativeInteger,
  hasMore: z.boolean(),
});

const taxonomyKind = z.enum(["category", "deviceType", "roleTag", "deviceCapability", "protocol"]);
const taxonomyValueOutput = z.object({
  id: z.string(), kind: taxonomyKind, value: z.string(), status: z.enum(["active", "deprecated"]), source: z.enum(["builtin-seed", "human", "imported", "system"]),
}).passthrough();
const taxonomyAliasOutput = z.object({
  id: z.string(), kind: taxonomyKind, aliasValue: z.string(), canonicalValue: z.string(), status: z.enum(["active", "deprecated"]), migrationRisk: z.enum(["low", "medium", "high"]),
}).passthrough();
const templateOutput = z.object({
  id: z.string().optional(), label: z.string(), deviceType: z.string(), ports: z.array(openObject), manufacturer: z.string().optional(), modelNumber: z.string().optional(),
}).passthrough();
const templateRefOutput = z.object({
  templateId: z.string(), manufacturer: nullableString, model: nullableString, label: nullableString,
}).passthrough();
const auditIssueOutput = z.object({
  code: z.string(), severity: z.enum(["error", "warning", "info"]), templateId: z.string(), message: z.string(), suggestion: z.string(),
}).passthrough();
const manufacturerOutput = z.object({
  manufacturer: z.string(), templateCount: nonNegativeInteger, issueCount: nonNegativeInteger, errorCount: nonNegativeInteger, warningCount: nonNegativeInteger,
}).passthrough();
const relatedTemplateOutput = templateRefOutput.extend({
  relationshipReasons: z.array(z.string()), matchScore: z.number(), auditIssueCount: nonNegativeInteger,
}).passthrough();
const classificationConflictOutput = z.object({
  conflictType: z.string(), strength: z.number(), affectedTemplates: z.array(templateRefOutput), classification: z.string(),
}).passthrough();
const issueClusterOutput = z.object({
  clusterKey: z.string(), issueCount: nonNegativeInteger, affectedTemplateCount: nonNegativeInteger, severityDistribution: openRecord,
}).passthrough();
const taxonomyCoverageOutput = z.object({
  kind: taxonomyKind, storedValue: z.string(), templateCount: nonNegativeInteger, taxonomyStatus: z.string(), registryMode: z.string(),
}).passthrough();
const suspiciousTemplateOutput = templateRefOutput.extend({
  score: z.number(), scoreBreakdown: z.array(openObject), reasons: z.array(z.string()), errorCount: nonNegativeInteger, warningCount: nonNegativeInteger,
}).passthrough();
const proposalStatus = z.enum(["pending", "accepted", "rejected", "needs-manual-review", "superseded"]);
const proposalOutput = z.object({
  id: z.string(), templateId: z.string(), field: z.string(), proposalType: z.string(), status: proposalStatus, evidenceRefs: z.array(openObject), preview: openObject,
}).passthrough();
const taxonomyPreviewOutput = z.object({
  readOnly: z.literal(true), operation: z.string(), changeKey: z.string(), current: z.unknown(), proposed: z.unknown(), impact: openRecord,
}).passthrough();
const jetbuiltClassificationOutput = z.object({
  classificationVersion: z.string(), class: z.string(), schematicRelevant: z.boolean().nullable(), ruleId: nullableString, reason: nullableString,
}).passthrough();
const jetbuiltCandidateOutput = z.object({
  candidateKey: z.string(), normalizedManufacturer: z.string(), normalizedModel: z.string(), classification: jetbuiltClassificationOutput,
  lineItemOccurrences: nonNegativeInteger, projectCount: nonNegativeInteger, roomCount: nonNegativeInteger, priorityScore: z.number(),
}).passthrough();
const candidateUsageOutput = z.object({
  candidateKey: z.string(), lineItemOccurrences: nonNegativeInteger, projectCount: nonNegativeInteger, roomCount: nonNegativeInteger,
  systemCount: nonNegativeInteger, clientCount: nonNegativeInteger, byStage: z.array(openObject), byYear: z.array(openObject), cohortProjectCounts: openRecord,
}).passthrough();
const cooccurrenceItemOutput = z.object({
  candidateKey: z.string(), manufacturer: nullableString, model: nullableString, lineItemOccurrences: nonNegativeInteger, roomCount: nonNegativeInteger,
  projectCount: nonNegativeInteger, classification: jetbuiltClassificationOutput,
}).passthrough();
const projectGapStatus = z.enum([
  "exact-canonical-match", "known-non-schematic", "already-proposed", "unmatched-hardware-candidate", "possible-identity-variant", "needs-manual-review", "insufficient-identity",
]);
const projectGapProposalIdentityOutput = z.object({
  id: z.string(), manufacturer: nullableString, modelNumber: nullableString, status: z.string(), generationKey: nullableString, identityAliases: z.array(z.string()),
}).passthrough();
const projectGapCandidateResultOutput = z.object({
  runKey: z.string(), candidateKey: z.string(), projectNumber: z.string(), status: z.string(), validationIssues: z.array(z.string()), proposalId: nullableString, updatedAt: z.string(),
}).passthrough();
const projectGapTemplateRefOutput = z.object({
  id: nullableString, manufacturer: nullableString, modelNumber: nullableString, label: z.string(),
}).passthrough();
const projectGapCandidateOutput = z.object({
  candidateKey: z.string(), status: projectGapStatus, manufacturer: z.string(), model: z.string(), classification: jetbuiltClassificationOutput,
  projectUsage: z.object({ lineItemCount: nonNegativeInteger, validQuantityTotal: z.number(), rooms: z.array(openObject), systems: z.array(openObject) }).passthrough(),
  historicalUsageOutsideProject: z.object({ lineItemCount: nonNegativeInteger, validQuantityTotal: z.number(), projectCount: nonNegativeInteger, roomCount: nonNegativeInteger, systemCount: nonNegativeInteger }).passthrough(),
  currentCanonicalCollisionEvidence: z.array(projectGapTemplateRefOutput), possibleIdentityVariantEvidence: z.array(projectGapTemplateRefOutput), existingProposals: z.array(projectGapProposalIdentityOutput),
  previousResult: projectGapCandidateResultOutput.nullable(), generationKey: z.string(),
  projectGapContext: z.object({ runKey: z.string(), candidateKey: z.string(), projectNumber: z.string(), analysisVersion: z.string(), projectSourceFingerprint: z.string(), canonicalSnapshotIdentity: z.string() }).passthrough(),
}).passthrough();
const newTemplateProposalOutput = z.object({
  success: z.boolean(), readOnly: z.literal(false), proposalOnly: z.literal(true), applied: z.literal(false), proposal: proposalOutput.nullable(),
  validationIssues: z.array(z.string()), warnings, taxonomyValidation: z.array(openObject), exactCanonicalCollisions: z.array(openObject), exactAliasCollisions: z.array(openObject),
  possibleRelatedTemplates: z.array(openObject), searchTermCollisions: z.array(openObject), canonicalTemplateCountBefore: nonNegativeInteger, canonicalTemplateCountAfter: nonNegativeInteger,
  proposedTemplateSummary: openObject, alreadyExisting: z.boolean().optional(), proposalId: z.string().optional(), status: proposalStatus.optional(), proposalType: z.string().optional(),
  evidenceCount: nonNegativeInteger.optional(), candidateStatus: z.literal("needs-manual-review").optional(), attemptedTemplate: openObject.optional(),
}).passthrough();
const projectGapOutput = z.object({
  success: z.literal(true), readOnlyExternalSystems: z.literal(true), analysisVersion: z.string(), runKey: z.string(), projectSourceFingerprint: z.string(), canonicalSnapshotIdentity: z.string(),
  proposalStateVersion: z.string(), proposalStateIdentity: z.string(), proposalStateSource: z.enum(["local", "proposal-service"]), requestedProjectNumber: z.string(), matchedProjectId: z.string(),
  projectNumber: z.string(), projectName: nullableString, stage: nullableString, active: z.boolean().nullable(), cohortSemantics: z.array(openObject), lineItemCount: nonNegativeInteger,
  distinctCandidateIdentityCount: nonNegativeInteger, rooms: z.array(openObject), systems: z.array(openObject), candidates: z.array(projectGapCandidateOutput),
  insufficientIdentityLines: z.array(z.object({ lineItemId: z.string(), manufacturer: nullableString, model: nullableString, status: z.literal("insufficient-identity") }).passthrough()),
  exactCanonicalMatches: z.array(projectGapCandidateOutput), knownNonSchematicExclusions: z.array(projectGapCandidateOutput), existingPendingProposalMatches: z.array(projectGapCandidateOutput),
  unmatchedEligibleCandidates: z.array(projectGapCandidateOutput), possibleIdentityVariants: z.array(projectGapCandidateOutput), manualReviewCandidates: z.array(projectGapCandidateOutput),
  summary: openRecord, queryCounts: openRecord, versions: openRecord, warnings, acquisition: openObject.optional(),
}).passthrough();

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

export function openMcpDatabase(dbPath: string) {
  if (!existsSync(dbPath)) throw new McpLibraryError(`TateSide database does not exist: ${dbPath}`);
  const db = openDatabase(dbPath);
  try {
    assertMigrationsApplied(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createTateSideMcpServer(context: McpLibraryContext): McpServer {
  const server = new McpServer({ name: "easyschematic-library", version: "1.0.0" });
  const tools = createMcpLibraryTools(context);
  const register = (name: keyof typeof MCP_LIBRARY_TOOL_DESCRIPTIONS, inputSchema: z.ZodObject<z.ZodRawShape>, outputSchema: z.ZodObject<z.ZodRawShape>) => server.registerTool(name, {
    description: MCP_LIBRARY_TOOL_DESCRIPTIONS[name], inputSchema, outputSchema,
    annotations: { readOnlyHint: !name.startsWith("create_") },
  }, async (input) => {
    try {
      if (name === "create_library_doctor_new_template_proposal" && context.config.mcpLibraryDoctorProposalApiUrl) {
        if (!context.config.mcpLibraryDoctorProposalApiToken) throw new McpLibraryError("Proposal API token is required when the shared proposal API is configured");
        const response = await fetch(context.config.mcpLibraryDoctorProposalApiUrl, {
          method: "POST",
          headers: { "authorization": `Bearer ${context.config.mcpLibraryDoctorProposalApiToken}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const value = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new McpLibraryError(typeof value.error === "string" ? value.error : `Proposal API returned ${response.status}`);
        return result(value);
      }
      return result(await tools.executeAsync(name, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected MCP tool error";
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });

  register("list_taxonomy_values", z.object(common), boundedOutput(taxonomyValueOutput, { filtersApplied: openRecord }));
  register("list_taxonomy_aliases", z.object({ kind: z.string().optional(), status: z.string().optional(), canonicalValue: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(taxonomyAliasOutput, { filtersApplied: openRecord }));
  register("get_taxonomy_value", z.object({ kind: z.string(), value: z.string() }), readOutput({ value: taxonomyValueOutput.nullable() }));
  register("search_templates", z.object(templateSearch), boundedOutput(templateOutput, { filtersApplied: openRecord }));
  register("get_template", z.object({ id: z.string() }), readOutput({ template: templateOutput }));
  register("get_template_issues", z.object({ id: z.string(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(auditIssueOutput, { templateId: z.string(), summary: openObject }));
  register("get_library_audit", z.object({ manufacturer: z.string().optional(), severity: z.string().optional(), code: z.string().optional(), currentValue: z.string().optional(), templateId: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(auditIssueOutput, { headline: openObject, countsBySeverity: openRecord, countsByCode: openRecord, completeness: openObject, filtersApplied: openRecord }));
  register("preview_template_taxonomy", z.object({ id: z.string() }), readOutput({ templateId: z.string(), preview: openObject }));
  register("get_library_coverage", z.object({}), readOutput({ totalTemplates: nonNegativeInteger, manufacturers: nonNegativeInteger, categories: nonNegativeInteger, deviceTypes: nonNegativeInteger, issueCounts: openRecord, completeness: openObject }));
  register("list_manufacturers", z.object({ query: z.string().optional(), minimumTemplateCount: z.number().int().min(1).max(100).optional(), sort: z.enum(["name", "templateCount", "issueCount", "errorCount"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(manufacturerOutput, { filtersApplied: openRecord }));
  register("get_manufacturer_summary", z.object({ manufacturer: z.string() }), readOutput({ manufacturer: z.string(), totalTemplates: nonNegativeInteger, modelExamples: z.array(templateRefOutput), auditIssueCounts: openObject, completeness: openObject, anomalySignals: z.array(openObject) }));
  register("find_related_templates", z.object({ templateId: z.string(), strategy: z.enum(["balanced", "family", "manufacturer"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(relatedTemplateOutput, { templateId: z.string(), strategy: z.enum(["balanced", "family", "manufacturer"]), scoring: z.string() }));
  register("get_classification_conflicts", z.object({ manufacturer: z.string().optional(), conflictType: z.string().optional(), minimumStrength: z.number().int().min(1).max(100).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(classificationConflictOutput, { filtersApplied: openRecord }));
  register("get_library_issue_clusters", z.object({ grouping: z.enum(["issueCode", "manufacturer", "currentValue", "connectorType", "signalType", "direction", "category", "deviceType", "manufacturer+issueCode", "issueCode+currentValue"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(issueClusterOutput, { grouping: z.string() }));
  register("get_taxonomy_coverage_gaps", z.object({ kind: z.enum(["category", "deviceType", "roleTag", "deviceCapability", "protocol"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(taxonomyCoverageOutput, { registryAvailability: z.string(), filtersApplied: openRecord }));
  register("get_suspicious_templates", z.object({ manufacturer: z.string().optional(), category: z.string().optional(), deviceType: z.string().optional(), issueCode: z.string().optional(), severity: z.enum(["error", "warning", "info"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), boundedOutput(suspiciousTemplateOutput, { scoring: z.string(), filtersApplied: openRecord }));
  register("get_template_triage_bundle", z.object({ templateId: z.string() }), readOutput({ template: templateRefOutput, dimensions: openObject, ports: z.array(openObject), existingAuditIssues: openObject, taxonomyPreview: openObject, taxonomyStatus: openObject, taxonomyCoverage: z.array(openObject), relatedTemplates: z.array(relatedTemplateOutput), manufacturerContext: openObject.nullable(), classificationConflicts: z.array(openObject), proposals: z.array(openObject), warnings }));
  register("create_library_doctor_proposal", z.object({ templateId: z.string(), field: z.string(), proposedValue: z.unknown().optional(), currentValue: z.unknown().optional(), proposalType: z.string(), confidence: z.string().optional(), risk: z.string().optional(), sourceIssueCode: z.string().optional(), sourceIssueGroup: z.string().optional(), sourceCurrentValue: z.unknown().optional(), evidenceRefs: z.array(z.unknown()).optional(), rationale: z.string().optional(), createdBy: z.string().optional(), supersedesProposalId: z.string().optional(), generationKey: z.string().optional() }), successfulOutput({ readOnly: z.literal(false), proposal: proposalOutput, warnings }));
  register("create_library_doctor_new_template_proposal", z.object({ proposedTemplate: z.record(z.string(), z.unknown()), identityAliases: z.array(z.string()).optional(), evidenceRefs: z.array(z.unknown()).optional(), rationale: z.string().optional(), classificationConfidence: z.enum(["low", "medium", "high"]).optional(), risk: z.enum(["low", "medium", "high"]).optional(), historicalUsageEvidence: z.record(z.string(), z.unknown()).optional(), operationalNotes: z.array(z.string()).optional(), createdBy: z.string().optional(), supersedesProposalId: z.string().optional(), generationKey: z.string().optional(), qualityGates: z.record(z.string(), z.unknown()).optional(), projectGapContext: z.record(z.string(), z.unknown()).optional() }), newTemplateProposalOutput);
  register("preview_taxonomy_registry_change", z.object({ operation: z.string(), payload: z.record(z.string(), z.unknown()) }), successfulOutput({ ...taxonomyPreviewOutput.shape }));
  register("create_taxonomy_registry_change_proposal", z.object({ operation: z.string(), payload: z.record(z.string(), z.unknown()), changeKey: z.string(), rationale: z.string().optional(), createdBy: z.string().optional() }), successfulOutput({ proposal: proposalOutput, preview: taxonomyPreviewOutput, warnings }));
  // Read-only Jetbuilt historical discovery (requires optional historyDb on context).
  register("get_jetbuilt_library_coverage_summary", z.object({
    cohort: z.string().optional(), stage: z.string().optional(), manufacturer: z.string().optional(),
    from: z.string().optional(), to: z.string().optional(), dateBasis: z.enum(["created", "updated"]).optional(),
  }), readOutput({ classificationVersion: z.string(), canonicalMatcherVersion: z.string(), rankingVersion: z.string(), totalHistoricalLineItems: nonNegativeInteger, exactCanonicalMatches: nonNegativeInteger, unmatchedLines: nonNegativeInteger, knownNonSchematicLines: nonNegativeInteger, eligibleUnmatchedCandidateLines: nonNegativeInteger, distinctEligibleCandidateIdentities: nonNegativeInteger, highPriorityCandidateCount: nonNegativeInteger, countsByCohort: openRecord, countsByManufacturer: z.array(openObject), warnings }));
  register("get_jetbuilt_library_candidates", z.object({
    cohort: z.string().optional(), stage: z.string().optional(), manufacturer: z.string().optional(),
    from: z.string().optional(), to: z.string().optional(), dateBasis: z.enum(["created", "updated"]).optional(),
    limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
    minimumProjectCount: z.number().int().min(0).max(1_000_000).optional(),
    minimumRoomCount: z.number().int().min(0).max(1_000_000).optional(),
    minimumDeliveredOrInstalledProjectCount: z.number().int().min(0).max(1_000_000).optional(),
    excludeKnownNonSchematic: z.boolean().optional(),
    exactCanonicalMatch: z.boolean().optional(),
    minimumPriorityScore: z.number().optional(),
  }), boundedOutput(jetbuiltCandidateOutput, { classificationVersion: z.string(), canonicalMatcherVersion: z.string(), rankingVersion: z.string(), rankingFormula: z.string(), filtersApplied: openObject, warnings }));
  register("get_jetbuilt_library_candidate", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
  }), readOutput({ classificationVersion: z.string(), canonicalMatcherVersion: z.string(), rankingVersion: z.string(), candidate: jetbuiltCandidateOutput, usage: candidateUsageOutput, cooccurrence: openObject, canonicalCorrelation: openObject, warnings }));
  register("get_jetbuilt_candidate_usage", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
  }), readOutput({ ...candidateUsageOutput.shape }));
  register("get_jetbuilt_candidate_cooccurrence", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
    cohort: z.string().optional(), stage: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
    minimumRoomCount: z.number().int().min(1).max(1_000_000).optional(),
  }), boundedOutput(cooccurrenceItemOutput, { targetCandidateKey: z.string(), targetRoomCount: nonNegativeInteger, metricsNote: z.string() }));
  register("get_jetbuilt_project_library_gap_analysis", z.object({
    projectNumber: z.string(), allowOnDemandAcquisition: z.boolean().optional(),
  }), projectGapOutput);
  return server;
}

/** Open Jetbuilt history DB for read-only discovery tools when TATESIDE_JETBUILT_HISTORY_DB_PATH is set. */
export function openOptionalHistoryDatabase(): DatabaseSync | null {
  const historyPath = process.env.TATESIDE_JETBUILT_HISTORY_DB_PATH?.trim();
  if (!historyPath) return null;
  if (!existsSync(historyPath)) {
    throw new McpLibraryError(`Configured Jetbuilt history database does not exist: ${historyPath}`);
  }
  const historyDb = openJetbuiltHistoryDatabase(historyPath);
  runJetbuiltHistoryMigrations(historyDb);
  return historyDb;
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.mcpLibraryEnabled) throw new McpLibraryError("Set TATESIDE_MCP_LIBRARY_ENABLED=1 to start the MCP library server");
  const db = openMcpDatabase(config.dbPath);
  const historyDb = openOptionalHistoryDatabase();
  const server = createTateSideMcpServer({ db, config, historyDb, jetbuiltApiKey: process.env.JETBUILT_API_KEY?.trim() || null });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("mcpServer.js")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
