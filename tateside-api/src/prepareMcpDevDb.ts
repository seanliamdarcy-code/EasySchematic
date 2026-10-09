import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openDatabase, runMigrations } from "./db.js";

function migrationIds(db: DatabaseSync): string[] {
  try {
    return (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map(({ id }) => id);
  } catch {
    return [];
  }
}

function assertIntegrity(db: DatabaseSync, label: string): void {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") throw new Error(`${label} integrity check failed`);
}

export async function prepareMcpDevDatabase(sourceArg: string, destinationArg: string): Promise<{ source: string; destination: string; migrationsApplied: string[] }> {
  const source = path.resolve(sourceArg);
  const destination = path.resolve(destinationArg);
  if (source.toLowerCase() === destination.toLowerCase()) throw new Error("Source and destination must be different paths");
  if (!existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  mkdirSync(path.dirname(destination), { recursive: true });

  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    assertIntegrity(sourceDb, "Source database");
    await backup(sourceDb, destination);
  } finally {
    sourceDb.close();
  }

  const destinationDb = openDatabase(destination);
  try {
    const before = new Set(migrationIds(destinationDb));
    runMigrations(destinationDb);
    assertIntegrity(destinationDb, "Destination database");
    const migrationsApplied = migrationIds(destinationDb).filter((id) => !before.has(id));
    return { source, destination, migrationsApplied };
  } finally {
    destinationDb.close();
  }
}

async function main(): Promise<void> {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("Usage: npm run tateside:mcp:prepare-dev-db -- <source.db> <destination.db>");
  process.stdout.write(`${JSON.stringify(await prepareMcpDevDatabase(source, destination), null, 2)}\n`);
}

if (process.argv[1]?.endsWith("prepareMcpDevDb.js")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
