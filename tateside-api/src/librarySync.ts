import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

import { openDatabase, runMigrations } from "./db.js";

export interface SyncLibraryOptions {
  sourcePath: string;
  destinationPath: string;
}

export interface SyncLibraryResult {
  devicesCopied: number;
  versionsCopied: number;
}

interface DeviceRow {
  id: string;
  unique_key: string;
  label: string;
  manufacturer: string | null;
  model_number: string | null;
  device_type: string;
  category: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_email: string | null;
  updated_by_email: string | null;
  deleted_at: string | null;
}

interface DeviceVersionRow {
  id: string;
  device_id: string;
  version: number;
  template_json: string;
  source: string | null;
  note: string | null;
  created_at: string;
  created_by_email: string | null;
}

function resolveAndValidatePaths(sourcePath: string, destinationPath: string): { source: string; destination: string } {
  if (!sourcePath || !destinationPath) {
    throw new Error("Both --source and --destination are required");
  }
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error("source and destination paths must be different");
  }
  if (!existsSync(source)) {
    throw new Error(`source database does not exist: ${source}`);
  }
  return { source, destination };
}

export function syncDeviceLibraryFromProd(options: SyncLibraryOptions): SyncLibraryResult {
  const { source, destination } = resolveAndValidatePaths(options.sourcePath, options.destinationPath);

  const destDb = openDatabase(destination);
  try {
    runMigrations(destDb);

    const sourceDb = new DatabaseSync(source, { readOnly: true });
    try {
      const deviceRows = sourceDb
        .prepare("SELECT * FROM devices WHERE deleted_at IS NULL")
        .all() as unknown as DeviceRow[];

      const activeDeviceIds = deviceRows
        .map((d) => d.id)
        .filter((id): id is string => Boolean(id));

      let versionRows: DeviceVersionRow[] = [];
      if (activeDeviceIds.length > 0) {
        const placeholders = activeDeviceIds.map(() => "?").join(",");
        versionRows = sourceDb
          .prepare(`SELECT * FROM device_versions WHERE device_id IN (${placeholders})`)
          .all(...activeDeviceIds) as unknown as DeviceVersionRow[];
      }

      destDb.exec("BEGIN");
      try {
        destDb.exec("PRAGMA defer_foreign_keys = ON");
        // Clear only library tables; leave schematics and other data intact.
        destDb.exec("DELETE FROM device_audit_log");
        destDb.exec("DELETE FROM device_versions");
        destDb.exec("DELETE FROM devices");

        // Insert devices with their original current_version_id (FK check deferred).
        const insertDevice = destDb.prepare(`
          INSERT INTO devices (
            id, unique_key, label, manufacturer, model_number, device_type, category,
            current_version_id, created_at, updated_at, created_by_email, updated_by_email, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const d of deviceRows) {
          insertDevice.run(
            d.id,
            d.unique_key,
            d.label,
            d.manufacturer ?? null,
            d.model_number ?? null,
            d.device_type,
            d.category ?? null,
            d.current_version_id ?? null,
            d.created_at,
            d.updated_at,
            d.created_by_email ?? null,
            d.updated_by_email ?? null,
            d.deleted_at ?? null,
          );
        }

        const insertVersion = destDb.prepare(`
          INSERT INTO device_versions (
            id, device_id, version, template_json, source, note, created_at, created_by_email
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const v of versionRows) {
          insertVersion.run(
            v.id,
            v.device_id,
            v.version,
            v.template_json,
            v.source ?? null,
            v.note ?? null,
            v.created_at,
            v.created_by_email ?? null,
          );
        }

        destDb.exec("COMMIT");
      } catch (err) {
        destDb.exec("ROLLBACK");
        throw err;
      }

      const devicesCopiedRow = destDb
        .prepare("SELECT COUNT(*) as c FROM devices WHERE deleted_at IS NULL")
        .get() as { c: number };
      const versionsCopiedRow = destDb
        .prepare("SELECT COUNT(*) as c FROM device_versions")
        .get() as { c: number };

      return {
        devicesCopied: devicesCopiedRow.c,
        versionsCopied: versionsCopiedRow.c,
      };
    } finally {
      sourceDb.close();
    }
  } finally {
    destDb.close();
  }
}
