import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { saveTemplates, listCurrentTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { prepareMcpDevDatabase } from "../dist-tateside-api/tateside-api/src/prepareMcpDevDb.js";

test("dev DB preparation uses backup, migrates only destination, and refuses unsafe paths", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-mcp-prepare-"));
  const source = path.join(root, "source.db");
  const destination = path.join(root, "disposable.db");
  const sourceDb = openDatabase(source);
  try {
    runMigrations(sourceDb);
    saveTemplates(sourceDb, { templates: [{ label: "Fixture", manufacturer: "Acme", modelNumber: "ONE", deviceType: "camera", category: "Cameras", ports: [] }] });
    sourceDb.exec("DROP TABLE taxonomy_registry_events; DROP TABLE taxonomy_registry_aliases; DROP TABLE taxonomy_registry_values");
    sourceDb.prepare("DELETE FROM schema_migrations WHERE id = ?").run("0010_dynamic_taxonomy_registry.sql");
    const sourceMigrations = sourceDb.prepare("SELECT id FROM schema_migrations ORDER BY id").all();
    const result = await prepareMcpDevDatabase(source, destination);
    assert.equal(result.source, source);
    assert.equal(result.destination, destination);
    assert.deepEqual(result.migrationsApplied, ["0010_dynamic_taxonomy_registry.sql"]);
    assert.equal(existsSync(destination), true);
    const destinationDb = openDatabase(destination);
    assert.equal(listCurrentTemplates(destinationDb).length, 1);
    assert.equal(destinationDb.prepare("SELECT count(*) AS count FROM schema_migrations").get().count, sourceMigrations.length + 1);
    assert.equal(destinationDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    destinationDb.close();
    assert.deepEqual(sourceDb.prepare("SELECT id FROM schema_migrations ORDER BY id").all(), sourceMigrations);
    await assert.rejects(prepareMcpDevDatabase(source, source), /different paths/);
    await assert.rejects(prepareMcpDevDatabase(source, destination), /already exists/);
  } finally {
    sourceDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});
