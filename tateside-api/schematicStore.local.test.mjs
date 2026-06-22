import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConfig } from "../dist-tateside-api/tateside-api/src/config.js";
import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import {
  SchematicStoreError,
  createSchematic,
  getCurrentSchematic,
  getSchematicVersion,
  listRecentSchematics,
  listSchematicVersions,
  restoreSchematicVersion,
  saveSchematic,
} from "../dist-tateside-api/tateside-api/src/schematicStore.js";

function makeSchematic(name, extra = {}) {
  return {
    version: 1,
    name,
    nodes: [],
    edges: [],
    ...extra,
  };
}

function withTempStore(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-schematic-store-"));
  const dbPath = path.join(root, "store.db");
  const repositoryPath = path.join(root, "repository");
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    return run({ root, db, dbPath, repositoryPath });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function expectStoreError(action, status, messagePattern) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof SchematicStoreError);
    assert.equal(error.status, status);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

test("schematic store lifecycle and integrity checks", () => {
  withTempStore(({ db, repositoryPath }) => {
    const maxJsonBytes = 16 * 1024;
    const created = createSchematic(db, repositoryPath, maxJsonBytes, {
      schematic: makeSchematic("Alpha", {
        customTemplates: [{ label: "Template", deviceType: "device", ports: [] }],
      }),
      source: "create-test",
      actorEmail: "user@example.com",
    });

    assert.match(created.schematic.id, /^sch_[a-f0-9]{32}$/);
    assert.equal(created.schematic.currentVersionSequence, 1);
    assert.equal(created.version.sequence, 1);
    assert.equal(created.data.name, "Alpha");

    const noopSave = saveSchematic(db, repositoryPath, maxJsonBytes, created.schematic.id, {
      schematic: {
        edges: [],
        customTemplates: [{ ports: [], deviceType: "device", label: "Template" }],
        name: "Alpha",
        nodes: [],
        version: 1,
      },
      source: "save-test",
    });

    assert.equal(noopSave.createdNewVersion, false);
    assert.equal(noopSave.schematic.currentVersionSequence, 1);

    const changed = saveSchematic(db, repositoryPath, maxJsonBytes, created.schematic.id, {
      schematic: makeSchematic("Alpha v2", {
        notes: { stage: "changed" },
      }),
      source: "save-test",
    });

    assert.equal(changed.createdNewVersion, true);
    assert.equal(changed.schematic.currentVersionSequence, 2);
    assert.equal(changed.version.sequence, 2);
    assert.equal(changed.data.name, "Alpha v2");

    const recent = listRecentSchematics(db);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, created.schematic.id);
    assert.equal(recent[0].currentVersionSequence, 2);

    const current = getCurrentSchematic(db, repositoryPath, created.schematic.id);
    assert.equal(current.version.sequence, 2);
    assert.equal(current.data.name, "Alpha v2");

    const oldVersion = getSchematicVersion(db, repositoryPath, created.schematic.id, 1);
    assert.equal(oldVersion.version.sequence, 1);
    assert.equal(oldVersion.data.name, "Alpha");

    const restored = restoreSchematicVersion(db, repositoryPath, 16 * 1024, created.schematic.id, 1, {
      source: "restore-test",
    });

    assert.equal(restored.schematic.currentVersionSequence, 3);
    assert.equal(restored.version.sequence, 3);
    assert.equal(restored.data.name, "Alpha");

    const versions = listSchematicVersions(db, created.schematic.id);
    assert.deepEqual(
      versions.versions.map((version) => [version.sequence, version.isCurrent]),
      [[3, true], [2, false], [1, false]],
    );
  });
});

test("restore enforces the configured size limit", () => {
  withTempStore(({ db, repositoryPath }) => {
    const largePayload = "x".repeat(512);
    const created = createSchematic(db, repositoryPath, 4096, {
      schematic: makeSchematic("Small"),
    });

    saveSchematic(db, repositoryPath, 4096, created.schematic.id, {
      schematic: makeSchematic("Large", {
        metadata: {
          payload: largePayload,
        },
      }),
    });

    saveSchematic(db, repositoryPath, 4096, created.schematic.id, {
      schematic: makeSchematic("Small again"),
    });

    expectStoreError(
      () => restoreSchematicVersion(db, repositoryPath, 128, created.schematic.id, 2, { source: "restore-test" }),
      400,
      /exceeds 128 bytes/,
    );

    const versions = listSchematicVersions(db, created.schematic.id);
    assert.deepEqual(versions.versions.map((version) => version.sequence), [3, 2, 1]);
    assert.equal(getCurrentSchematic(db, repositoryPath, created.schematic.id).version.sequence, 3);
  });
});

test("schematic store rejects invalid shapes and invalid identifiers", () => {
  withTempStore(({ db, repositoryPath }) => {
    expectStoreError(
      () => createSchematic(db, repositoryPath, 4096, { schematic: { version: 1, name: "Bad", nodes: {} } }),
      400,
      /schematic\.nodes must be an array/,
    );

    const created = createSchematic(db, repositoryPath, 4096, {
      schematic: makeSchematic("Valid"),
    });

    expectStoreError(
      () => getCurrentSchematic(db, repositoryPath, "../escape"),
      400,
      /invalid/i,
    );
    expectStoreError(
      () => listSchematicVersions(db, "..\\escape"),
      400,
      /invalid/i,
    );
    expectStoreError(
      () => getSchematicVersion(db, repositoryPath, created.schematic.id, 0),
      400,
      /positive integer/i,
    );
    expectStoreError(
      () => saveSchematic(db, repositoryPath, 4096, "sch_../../badbadbadbadbadbadbadbadbadba", {
        schematic: makeSchematic("Bad ID"),
      }),
      400,
      /invalid/i,
    );
  });
});

test("schematic store detects corrupted stored objects", () => {
  withTempStore(({ db, repositoryPath }) => {
    const created = createSchematic(db, repositoryPath, 4096, {
      schematic: makeSchematic("Integrity"),
    });

    const hash = created.schematic.currentHash;
    const objectPath = path.join(repositoryPath, "objects", hash.slice(0, 2), `${hash}.json`);
    writeFileSync(objectPath, JSON.stringify(makeSchematic("Tampered")), "utf8");

    expectStoreError(
      () => getCurrentSchematic(db, repositoryPath, created.schematic.id),
      409,
      /integrity check failed/,
    );
  });
});

test("config default repository root does not duplicate the schematics segment", () => {
  const originalEnv = {
    TATESIDE_DATA_DIR: process.env.TATESIDE_DATA_DIR,
    TATESIDE_SCHEMATIC_REPOSITORY_PATH: process.env.TATESIDE_SCHEMATIC_REPOSITORY_PATH,
  };
  const tempDataDir = mkdtempSync(path.join(os.tmpdir(), "tateside-config-"));

  try {
    process.env.TATESIDE_DATA_DIR = tempDataDir;
    delete process.env.TATESIDE_SCHEMATIC_REPOSITORY_PATH;

    const config = getConfig();
    assert.equal(config.schematicRepositoryPath, path.join(tempDataDir, "schematic-repository"));
  } finally {
    if (originalEnv.TATESIDE_DATA_DIR == null) {
      delete process.env.TATESIDE_DATA_DIR;
    } else {
      process.env.TATESIDE_DATA_DIR = originalEnv.TATESIDE_DATA_DIR;
    }

    if (originalEnv.TATESIDE_SCHEMATIC_REPOSITORY_PATH == null) {
      delete process.env.TATESIDE_SCHEMATIC_REPOSITORY_PATH;
    } else {
      process.env.TATESIDE_SCHEMATIC_REPOSITORY_PATH = originalEnv.TATESIDE_SCHEMATIC_REPOSITORY_PATH;
    }

    rmSync(tempDataDir, { recursive: true, force: true });
  }
});
