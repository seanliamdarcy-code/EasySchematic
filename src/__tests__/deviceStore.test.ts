import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, runMigrations } from "../../tateside-api/src/db.ts";
import { saveTemplates } from "../../tateside-api/src/deviceStore.ts";
import type { DeviceTemplate } from "../types";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "device-store-test-"));
  tempDirs.push(dir);
  const db = openDatabase(path.join(dir, "tateside.db"));
  runMigrations(db);
  dbs.push(db);
  return db;
}

function netgearSwitch(modelNumber: string): Omit<DeviceTemplate, "id" | "version"> {
  return {
    label: `NETGEAR ${modelNumber} AV Line Managed Switch`,
    manufacturer: "NETGEAR",
    modelNumber,
    deviceType: "network-switch",
    category: "Network",
    ports: [
      {
        id: "port-1",
        label: "1",
        signalType: "network",
        connectorType: "rj45",
        direction: "bidirectional",
      },
    ],
  };
}

describe("device library storage", () => {
  it("keeps PoE+ and PoE++ model identities distinct", () => {
    const db = createDb();

    const saved = saveTemplates(db, {
      templates: [
        netgearSwitch("M4250-10G2XF-PoE+"),
        netgearSwitch("M4250-10G2XF-PoE++"),
      ],
      source: "test",
    });

    expect(saved.map((template) => template.modelNumber)).toEqual([
      "M4250-10G2XF-PoE+",
      "M4250-10G2XF-PoE++",
    ]);

    const rows = db.prepare("SELECT unique_key FROM devices ORDER BY model_number").all() as { unique_key: string }[];
    expect(rows.map((row) => row.unique_key)).toEqual([
      "netgear:m4250-10g2xf-poe-plus:network-switch",
      "netgear:m4250-10g2xf-poe-plus-plus:network-switch",
    ]);
  });

  it("does not treat an old PoE+ key as a duplicate of a new PoE++ model", () => {
    const db = createDb();
    const [poePlus] = saveTemplates(db, {
      templates: [netgearSwitch("M4250-10G2XF-PoE+")],
      source: "test",
    });
    expect(poePlus).toBeDefined();

    db.prepare("UPDATE devices SET unique_key = ? WHERE id = ?")
      .run("netgear:m4250-10g2xf-poe:network-switch", poePlus!.id);

    const [poePlusPlus] = saveTemplates(db, {
      templates: [netgearSwitch("M4250-10G2XF-PoE++")],
      source: "test",
    });

    expect(poePlusPlus?.modelNumber).toBe("M4250-10G2XF-PoE++");
  });

  it("still rejects genuinely duplicated template identities in one import", () => {
    const db = createDb();

    expect(() => saveTemplates(db, {
      templates: [
        netgearSwitch("M4250-10G2XF-PoE+"),
        netgearSwitch("M4250-10G2XF-PoE+"),
      ],
      source: "test",
    })).toThrow(/duplicates template 1/);
  });
});
