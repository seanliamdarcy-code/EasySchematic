import path from "node:path";
import { openDatabase } from "./db.js";
import { matchHistoryTemplates, openJetbuiltHistoryDatabase, runJetbuiltHistoryMigrations } from "./jetbuiltHistoryStore.js";
import { syncJetbuiltHistory, type JetbuiltHistoryBounds } from "./jetbuiltHistorySync.js";

function values(name: string): string[] {
  const found: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) found.push(...process.argv[++index].split(","));
  }
  return found;
}

function value(name: string): string | undefined {
  return values(name).at(-1);
}

async function main(): Promise<void> {
  const apiKey = process.env.JETBUILT_API_KEY?.trim() ?? "";
  const dbPath = path.resolve(value("--db") ?? process.env.TATESIDE_JETBUILT_HISTORY_DB_PATH ?? ".tateside-data/jetbuilt-history.db");
  const max = value("--max-projects");
  const bounds: JetbuiltHistoryBounds = {
    projectIds: values("--project-id"),
    minCreatedAt: value("--min-created-at"),
    maxCreatedAt: value("--max-created-at"),
    minUpdatedAt: value("--min-updated-at"),
    maxUpdatedAt: value("--max-updated-at"),
    maxProjectCount: max == null ? undefined : Number(max),
  };
  const db = openJetbuiltHistoryDatabase(dbPath);
  try {
    runJetbuiltHistoryMigrations(db);
    const result = await syncJetbuiltHistory(db, bounds, {
      apiKey,
      baseUrl: process.env.JETBUILT_API_BASE_URL,
      indexPath: "",
      refreshMs: 0,
    });
    const canonicalPath = value("--canonical-db") ?? process.env.TATESIDE_DB_PATH;
    let canonicalMatches: number | null = null;
    if (canonicalPath) {
      const canonicalDb = openDatabase(path.resolve(canonicalPath));
      try { canonicalMatches = matchHistoryTemplates(db, canonicalDb); } finally { canonicalDb.close(); }
    }
    process.stdout.write(`${JSON.stringify({ ...result, dbPath, canonicalMatches })}\n`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
