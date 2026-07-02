import { describe, expect, it } from "vitest";
import { canonicalizeJetbuiltModel, extractItemsToDevices } from "../../tateside-api/src/jetbuilt.ts";

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

  it("preserves separate room placements for the same model", () => {
    const devices = extractItemsToDevices([
      {
        id: "item-1",
        manufacturer_name: "QSC",
        model: "AD-C6T",
        short_description: "Ceiling speaker",
        quantity: 2,
        room_name: "Gym",
      },
      {
        id: "item-2",
        manufacturer_name: "QSC",
        model: "AD-C6T",
        short_description: "Ceiling speaker",
        quantity: 4,
        room_name: "Spa",
      },
      {
        id: "item-3",
        manufacturer_name: "QSC",
        model: "AD-C6T",
        short_description: "Ceiling speaker",
        quantity: 1,
        room_name: "Gym",
      },
    ]);

    expect(devices).toHaveLength(2);
    expect(devices.map((device) => [device.roomName, device.quantity])).toEqual([
      ["Gym", 3],
      ["Spa", 4],
    ]);
  });

  it("extracts room and system labels from Jetbuilt object values", () => {
    const devices = extractItemsToDevices([
      {
        id: "item-1",
        manufacturer_name: "QSC",
        model: "Core Nano",
        short_description: "Audio DSP processor",
        quantity: 1,
        room: { id: 123, name: "Rack Room" },
        system: { id: 456, name: "Background Music" },
      },
    ]);

    expect(devices).toHaveLength(1);
    expect(devices[0].roomName).toBe("Rack Room");
    expect(devices[0].systemName).toBe("Background Music");
    expect(devices[0].sourceLineText).toContain("Room: Rack Room");
    expect(devices[0].sourceLineText).not.toContain("[object Object]");
  });
});
