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
  const register = (name: keyof typeof MCP_LIBRARY_TOOL_DESCRIPTIONS, inputSchema: z.ZodObject<z.ZodRawShape>) => server.registerTool(name, {
    description: MCP_LIBRARY_TOOL_DESCRIPTIONS[name], inputSchema,
    annotations: { readOnlyHint: !name.startsWith("create_") },
  }, (input) => {
    try {
      return result(tools.execute(name, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected MCP tool error";
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
    }
  });

  register("list_taxonomy_values", z.object(common));
  register("list_taxonomy_aliases", z.object({ kind: z.string().optional(), status: z.string().optional(), canonicalValue: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_taxonomy_value", z.object({ kind: z.string(), value: z.string() }));
  register("search_templates", z.object(templateSearch));
  register("get_template", z.object({ id: z.string() }));
  register("get_template_issues", z.object({ id: z.string(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_library_audit", z.object({ manufacturer: z.string().optional(), severity: z.string().optional(), code: z.string().optional(), currentValue: z.string().optional(), templateId: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("preview_template_taxonomy", z.object({ id: z.string() }));
  register("get_library_coverage", z.object({}));
  register("list_manufacturers", z.object({ query: z.string().optional(), minimumTemplateCount: z.number().int().min(1).max(100).optional(), sort: z.enum(["name", "templateCount", "issueCount", "errorCount"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_manufacturer_summary", z.object({ manufacturer: z.string() }));
  register("find_related_templates", z.object({ templateId: z.string(), strategy: z.enum(["balanced", "family", "manufacturer"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_classification_conflicts", z.object({ manufacturer: z.string().optional(), conflictType: z.string().optional(), minimumStrength: z.number().int().min(1).max(100).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_library_issue_clusters", z.object({ grouping: z.enum(["issueCode", "manufacturer", "currentValue", "connectorType", "signalType", "direction", "category", "deviceType", "manufacturer+issueCode", "issueCode+currentValue"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_taxonomy_coverage_gaps", z.object({ kind: z.enum(["category", "deviceType", "roleTag", "deviceCapability", "protocol"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_suspicious_templates", z.object({ manufacturer: z.string().optional(), category: z.string().optional(), deviceType: z.string().optional(), issueCode: z.string().optional(), severity: z.enum(["error", "warning", "info"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional() }));
  register("get_template_triage_bundle", z.object({ templateId: z.string() }));
  register("create_library_doctor_proposal", z.object({ templateId: z.string(), field: z.string(), proposedValue: z.unknown().optional(), currentValue: z.unknown().optional(), proposalType: z.string(), confidence: z.string().optional(), risk: z.string().optional(), sourceIssueCode: z.string().optional(), sourceIssueGroup: z.string().optional(), sourceCurrentValue: z.unknown().optional(), evidenceRefs: z.array(z.unknown()).optional(), rationale: z.string().optional(), createdBy: z.string().optional(), supersedesProposalId: z.string().optional(), generationKey: z.string().optional() }));
  register("preview_taxonomy_registry_change", z.object({ operation: z.string(), payload: z.record(z.string(), z.unknown()) }));
  register("create_taxonomy_registry_change_proposal", z.object({ operation: z.string(), payload: z.record(z.string(), z.unknown()), changeKey: z.string(), rationale: z.string().optional(), createdBy: z.string().optional() }));
  // Read-only Jetbuilt historical discovery (requires optional historyDb on context).
  register("get_jetbuilt_library_coverage_summary", z.object({
    cohort: z.string().optional(), stage: z.string().optional(), manufacturer: z.string().optional(),
    from: z.string().optional(), to: z.string().optional(), dateBasis: z.enum(["created", "updated"]).optional(),
  }));
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
  }));
  register("get_jetbuilt_library_candidate", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
  }));
  register("get_jetbuilt_candidate_usage", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
  }));
  register("get_jetbuilt_candidate_cooccurrence", z.object({
    candidateKey: z.string().optional(), manufacturer: z.string().optional(), model: z.string().optional(),
    cohort: z.string().optional(), stage: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(),
    minimumRoomCount: z.number().int().min(1).max(1_000_000).optional(),
  }));
  return server;
}

function openOptionalHistoryDatabase(): DatabaseSync | null {
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
  const server = createTateSideMcpServer({ db, config, historyDb });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("mcpServer.js")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
