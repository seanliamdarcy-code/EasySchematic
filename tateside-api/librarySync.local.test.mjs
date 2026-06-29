import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncDeviceLibraryFromProd } from "../dist-tateside-api/tateside-api/src/librarySync.js";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import { saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { getConfig } from "../dist-tateside-api/tateside-api/src/config.js";
import { createSchematic } from "../dist-tateside-api/tateside-api/src/schematicStore.js";

function withTempDbs(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-library-sync-"));
  const sourceDbPath = path.join(root, "source.db");
  const destDbPath = path.join(root, "dest.db");
  const sourceDb = openDatabase(sourceDbPath);
  const destDb = openDatabase(destDbPath);
  const destSchematicRepo = path.join(root, "dest-schematic-repo");
  mkdirSync(destSchematicRepo, { recursive: true });
  try {
    runMigrations(sourceDb);
    runMigrations(destDb);
    return run({ root, sourceDb, destDb, sourceDbPath, destDbPath, destSchematicRepo });
  } finally {
    sourceDb.close();
    destDb.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function makeTemplate(label, overrides = {}) {
  return {
    label,
    deviceType: "device",
    ports: [],
    ...overrides,
  };
}

function makeSchematicData(name) {
  return {
    version: 1,
    name,
    nodes: [],
    edges: [],
  };
}

test("library sync rejects invalid paths and same source/dest", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tateside-sync-val-"));
  try {
    const missing = path.join(tmp, "no-such.db");
    const dest = path.join(tmp, "d.db");
    assert.throws(() => syncDeviceLibraryFromProd({ sourcePath: missing, destinationPath: dest }), /source database does not exist/);
    assert.throws(() => syncDeviceLibraryFromProd({ sourcePath: "", destinationPath: dest }), /required/);
    assert.throws(() => syncDeviceLibraryFromProd({ sourcePath: dest, destinationPath: dest }), /must be different/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("library sync copies only active templates, excludes deleted, applies migrations, uses transaction safety", () => {
  withTempDbs(({ sourceDb, destDb, sourceDbPath, destDbPath, destSchematicRepo }) => {
    // Seed a schematic in staging (dest) BEFORE sync to prove library refresh leaves schematics intact.
    const maxJsonBytes = 1024 * 1024;
    const preSyncSchematic = createSchematic(destDb, destSchematicRepo, maxJsonBytes, {
      schematic: makeSchematicData("Staging Local Schematic"),
      source: "staging-pre-sync",
      actorEmail: "staging@test",
    });
    assert.equal(preSyncSchematic.schematic.title, "Staging Local Schematic");

    // Seed source with 2 active + 1 deleted
    const active1 = saveTemplates(sourceDb, {
      templates: [makeTemplate("Active One", { manufacturer: "Acme", modelNumber: "A1", deviceType: "switch" })],
      source: "seed",
    })[0];
    const active2 = saveTemplates(sourceDb, {
      templates: [makeTemplate("Active Two", { manufacturer: "Beta", modelNumber: "B2", deviceType: "router" })],
      source: "seed",
    })[0];

    // Create a deleted one
    const toDelete = saveTemplates(sourceDb, {
      templates: [makeTemplate("To Be Deleted", { manufacturer: "Old", modelNumber: "X9", deviceType: "device" })],
      source: "seed",
    })[0];
    // simulate delete via direct (bypass normal for test)
    const tombstone = `${toDelete.id}:deleted`;
    sourceDb.prepare("UPDATE devices SET unique_key = ?, deleted_at = datetime('now') WHERE id = ?").run(tombstone, toDelete.id);

    const result = syncDeviceLibraryFromProd({ sourcePath: sourceDbPath, destinationPath: destDbPath });

    assert.equal(result.devicesCopied, 2, "only active devices copied");
    assert.equal(result.versionsCopied, 2, "all versions for active devices copied");

    // Verify only actives
    const destDevices = destDb.prepare("SELECT label, deleted_at FROM devices ORDER BY label").all();
    assert.equal(destDevices.length, 2);
    assert.equal(destDevices[0].label, "Active One");
    assert.equal(destDevices[1].label, "Active Two");
    assert.ok(destDevices.every((d) => d.deleted_at == null));

    // No deleted in dest
    const deletedCount = destDb.prepare("SELECT COUNT(*) as c FROM devices WHERE deleted_at IS NOT NULL").get().c;
    assert.equal(deletedCount, 0);

    // Verify versions point correctly and json present
    const versions = destDb.prepare("SELECT device_id, version, template_json FROM device_versions").all();
    assert.equal(versions.length, 2);
    assert.ok(versions.every((v) => v.template_json.includes("Active")));

    // Source not mutated
    const srcCount = sourceDb.prepare("SELECT COUNT(*) as c FROM devices WHERE deleted_at IS NULL").get().c;
    assert.equal(srcCount, 2);

    // Assert schematic created before sync remains intact (library sync neither deletes nor imports schematics)
    const postSchemCount = destDb.prepare("SELECT COUNT(*) as c FROM schematics").get().c;
    assert.equal(postSchemCount, 1, "staging schematics remain after library sync");
    const postSchem = destDb.prepare("SELECT id, title FROM schematics WHERE id = ?").get(preSyncSchematic.schematic.id);
    assert.ok(postSchem);
    assert.equal(postSchem.title, "Staging Local Schematic");
    const schemVersCount = destDb.prepare("SELECT COUNT(*) as c FROM schematic_versions").get().c;
    assert.equal(schemVersCount, 1);
  });
});

test("library sync is transactional: failure leaves dest untouched", () => {
  withTempDbs(({ sourceDb, destDb, sourceDbPath, destDbPath }) => {
    const t = saveTemplates(sourceDb, { templates: [makeTemplate("Good", { deviceType: "device" })] })[0];

    // Corrupt current_version_id to a non-existent version (bypass FK for test setup only)
    sourceDb.exec("PRAGMA foreign_keys=OFF");
    sourceDb.prepare("UPDATE devices SET current_version_id = 'nonexistent-ver' WHERE id = ?").run(t.id);
    sourceDb.exec("PRAGMA foreign_keys=ON");

    // Pre add something to dest library
    const beforeCount = destDb.prepare("SELECT COUNT(*) as c FROM devices").get().c;

    assert.throws(() => {
      syncDeviceLibraryFromProd({ sourcePath: sourceDbPath, destinationPath: destDbPath });
    }, (err) => err instanceof Error && /FOREIGN KEY|constraint failed/i.test(err.message || ""));

    const afterCount = destDb.prepare("SELECT COUNT(*) as c FROM devices").get().c;
    assert.equal(afterCount, beforeCount, "partial write rolled back");
  });
});

test("getConfig hard-disables SharePoint via TATESIDE_DISABLE_SHAREPOINT=1 even with full SharePoint vars supplied", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tateside-disable-sp-"));
  const prevEnv = { ...process.env };
  try {
    process.env.TATESIDE_DATA_DIR = tmp;
    process.env.TATESIDE_DISABLE_SHAREPOINT = "1";
    // Supply complete SharePoint-like values; must still be null
    process.env.MS_ENTRA_TENANT_ID = "tenant-1";
    process.env.MS_GRAPH_CLIENT_ID = "client-1";
    process.env.MS_GRAPH_CLIENT_SECRET = "secret-1";
    process.env.TATESIDE_SHAREPOINT_SITE_ID = "site-1";
    process.env.TATESIDE_SHAREPOINT_DRIVE_ID = "drive-1";
    process.env.TATESIDE_SHAREPOINT_ROOT_FOLDER_ID = "root-1";
    process.env.MS_ENTRA_BASE_URL = "http://example.invalid";
    process.env.MS_GRAPH_BASE_URL = "http://example.invalid/v1.0";

    const cfg = getConfig();
    assert.equal(cfg.sharePoint, null, "sharePoint must be null when TATESIDE_DISABLE_SHAREPOINT=1");
  } finally {
    // restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("library sync copies ALL versions belonging to active devices (multi-version device) and preserves current_version_id", () => {
  withTempDbs(({ sourceDb, destDb, sourceDbPath, destDbPath }) => {
    const dev = saveTemplates(sourceDb, {
      templates: [makeTemplate("Multi-Version Dev", { manufacturer: "M", modelNumber: "V1", deviceType: "device" })],
      source: "seed",
    })[0];

    // Insert an additional historical version (current remains v1)
    const v1id = sourceDb.prepare("SELECT current_version_id FROM devices WHERE id = ?").get(dev.id).current_version_id;
    const v2id = "ver-mv-2";
    const v2json = JSON.stringify(makeTemplate("Multi-Version Dev", { manufacturer: "M", modelNumber: "V2", deviceType: "device" }));
    sourceDb.prepare(
      "INSERT INTO device_versions (id, device_id, version, template_json, source, note, created_at, created_by_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(v2id, dev.id, 2, v2json, "edit", "prior rev", new Date().toISOString(), null);

    const result = syncDeviceLibraryFromProd({ sourcePath: sourceDbPath, destinationPath: destDbPath });

    assert.equal(result.devicesCopied, 1);
    assert.equal(result.versionsCopied, 2, "all versions copied");

    const destDev = destDb.prepare("SELECT current_version_id FROM devices WHERE id = ?").get(dev.id);
    assert.equal(destDev.current_version_id, v1id, "current_version_id pointer preserved");

    const vers = destDb.prepare("SELECT id, version FROM device_versions WHERE device_id = ? ORDER BY version").all(dev.id);
    assert.equal(vers.length, 2);
    assert.equal(vers[0].id, v1id);
    assert.equal(vers[1].id, v2id);
  });
});
