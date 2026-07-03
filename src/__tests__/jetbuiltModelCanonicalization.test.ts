import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, runMigrations } from "../../tateside-api/src/db.ts";
import { saveTemplates } from "../../tateside-api/src/deviceStore.ts";
import { canonicalizeJetbuiltModel, extractItemsToDevices } from "../../tateside-api/src/jetbuilt.ts";
import { inspectQuoteDevicesAgainstLibrary } from "../../tateside-api/src/quoteImport.ts";
import { saveProductBundle } from "../../tateside-api/src/productBundleStore.ts";
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "jetbuilt-bundle-test-"));
  tempDirs.push(dir);
  const db = openDatabase(path.join(dir, "tateside.db"));
  runMigrations(db);
  dbs.push(db);
  return db;
}

function template(model: string): Omit<DeviceTemplate, "id" | "version"> {
  return {
    label: `Yealink ${model}`,
    manufacturer: "Yealink",
    modelNumber: model,
    deviceType: "video-codec",
    category: "Conferencing",
    ports: [],
  };
}

describe("Jetbuilt model canonicalization", () => {
  it("strips bundle-style numeric SKU suffixes when the device family is present in the product text", () => {
    expect(canonicalizeJetbuiltModel("A40-031", {
      description: "MeetingBarA40 (includes CTP25 touchpad)",
      productName: "A40 Meeting Bar",
      shortDescription: "Yealink A40-031 MeetingBarA40",
    })).toBe("A40");
  });

  it("keeps the raw model when there is no evidence that the suffix is just a commercial SKU", () => {
    expect(canonicalizeJetbuiltModel("VB-TVMount-01", {
      description: "VESA TV Mount for A50/A40/SmartVision 40",
      productName: "VB-TVMount-01",
      shortDescription: "Yealink VB-TVMount-01",
    })).toBe("VB-TVMount-01");
  });
});

describe("Jetbuilt bundle expansion", () => {
  it("resolves Yealink A50-031 into schematic-facing A50 and CTP25 children", () => {
    const db = createDb();
    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "Yealink",
      part_number: "A50-031",
      short_description: "Yealink A50 A50-031 Meeting Bar and CTP25 tablet",
      quantity: 1,
      room_name: "Meeting Room 1",
      system_name: "AV",
      product_id: 1,
    }]);

    expect(devices.map((device) => device.model)).toEqual(["A50", "CTP25"]);
    expect(devices.every((device) => device.sourceKind === "bundle_component")).toBe(true);
    expect(devices.every((device) => device.commercialSku === "A50-031")).toBe(true);
    expect(devices.every((device) => device.room === "Meeting Room 1" && device.system === "AV")).toBe(true);
  });

  it("does not pass the commercial parent SKU into library matching", () => {
    const db = createDb();
    saveTemplates(db, {
      templates: [template("A50-031")],
      source: "test",
    });

    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "Yealink",
      part_number: "A50-031",
      short_description: "Yealink A50 A50-031 Meeting Bar and CTP25 tablet",
      quantity: 1,
      product_id: 1,
    }]);
    const results = inspectQuoteDevicesAgainstLibrary(db, devices);

    expect(devices.some((device) => device.model === "A50-031")).toBe(false);
    expect(results.map((result) => result.status)).toEqual(["missing", "missing"]);
  });

  it("multiplies component quantities by bundle quantity", () => {
    const db = createDb();
    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "Yealink",
      part_number: "A50-031",
      short_description: "Yealink A50 A50-031 Meeting Bar and CTP25 tablet",
      quantity: 3,
      product_id: 1,
    }]);

    expect(devices.map((device) => device.quantity)).toEqual([3, 3]);
    expect(devices.map((device) => device.bundleQuantity)).toEqual([3, 3]);
  });

  it("keeps standalone A50 as a standalone product", () => {
    const db = createDb();
    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "Yealink",
      model: "A50",
      short_description: "Yealink MeetingBar A50",
      quantity: 1,
      product_id: 1,
    }]);

    expect(devices).toHaveLength(1);
    expect(devices[0]?.model).toBe("A50");
    expect(devices[0]?.sourceKind).toBe("standalone");
  });

  it("persists a saved bundle mapping and reuses it on the next import", () => {
    const db = createDb();
    saveProductBundle(db, {
      id: "bundle-test-kit",
      manufacturer: "TestCo",
      sku: "KIT-1",
      label: "TestCo KIT-1",
      source: "manual",
      components: [
        { manufacturer: "TestCo", model: "DSP1", quantityPerBundle: 2, schematicRelevant: true },
      ],
    });

    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "TestCo",
      part_number: "KIT-1",
      short_description: "TestCo KIT-1 with DSP1",
      quantity: 2,
      product_id: 1,
    }]);

    expect(devices).toHaveLength(1);
    expect(devices[0]?.model).toBe("DSP1");
    expect(devices[0]?.quantity).toBe(4);
    expect(devices[0]?.bundleId).toBe("bundle-test-kit");
  });

  it("does not emit non-schematic bundle accessories as children", () => {
    const db = createDb();
    saveProductBundle(db, {
      id: "bundle-accessory-test",
      manufacturer: "TestCo",
      sku: "ROOM-KIT",
      label: "Room kit",
      source: "manual",
      components: [
        { manufacturer: "TestCo", model: "DSP1", quantityPerBundle: 1, schematicRelevant: true },
        { manufacturer: "TestCo", model: "Wall bracket", quantityPerBundle: 1, schematicRelevant: false },
      ],
    });

    const devices = extractItemsToDevices(db, [{
      manufacturer_name: "TestCo",
      part_number: "ROOM-KIT",
      short_description: "Room kit with DSP and bracket",
      quantity: 1,
      product_id: 1,
    }]);

    expect(devices.map((device) => device.model)).toEqual(["DSP1"]);
  });
});
