import { describe, expect, it } from "vitest";
import { buildQuoteImportSchematic } from "../import/quoteSchematic";
import type { DeviceTemplate } from "../types";
import type { QuoteImportResultItem } from "../quoteImportTypes";

const template: DeviceTemplate = {
  id: "template-a50",
  version: 1,
  label: "Yealink A50",
  manufacturer: "Yealink",
  modelNumber: "A50",
  deviceType: "video-codec",
  ports: [{ id: "in", label: "LAN", direction: "bidirectional", signalType: "ethernet" }],
};

function item(model: string, room: string, exactId?: string): QuoteImportResultItem {
  return {
    manufacturer: "Yealink",
    model,
    description: null,
    quantity: 1,
    sourceLineText: null,
    normalizedLookupKey: model.toLowerCase(),
    room,
    system: "AV",
    status: exactId ? "already_in_library" : "missing",
    exactMatch: exactId ? {
      id: exactId,
      label: model,
      manufacturer: "Yealink",
      modelNumber: model,
      normalizedLookupKey: model.toLowerCase(),
      matchReason: "exact",
    } : null,
    possibleMatches: [],
    portReuseCandidates: [],
  };
}

describe("quote import schematic handoff", () => {
  it("expands quantities into separately wireable instances with unique Port ids", () => {
    const repeated = { ...item("A50", "Boardroom", "template-a50"), quantity: 3 };
    const file = buildQuoteImportSchematic("P-7201", [repeated], { "template-a50": template }, { expandQuantities: true });
    const devices = file.nodes.filter((entry) => entry.type === "device");
    expect(devices.map((entry) => entry.data.label)).toEqual(["Yealink A50 1", "Yealink A50 2", "Yealink A50 3"]);
    expect(new Set(devices.flatMap((entry) => entry.data.ports.map((port) => port.id))).size).toBe(3);
    expect(devices.every((entry) => entry.parentId === "quote-room-1")).toBe(true);
    expect(file.nodes[0].style?.height).toBeGreaterThan(devices[2].position.y + 120);
  });

  it("keeps a room for unmatched equipment without guessing Ports and limits excessive quantities", () => {
    const missing = item("Unknown", "Boardroom");
    const file = buildQuoteImportSchematic("P-7201", [missing], {}, { includeUnmatched: false });
    expect(file.nodes.map((entry) => entry.type)).toEqual(["room"]);
    expect(() => buildQuoteImportSchematic("P", [{ ...missing, quantity: 1001 }], {}, { expandQuantities: true })).toThrow(/1000/);
  });

  it("creates room containers and parents imported devices into their rooms", () => {
    const file = buildQuoteImportSchematic("P-7201", [
      item("A50", "Yealink A50", "template-a50"),
      item("CTP25", "Yealink A50"),
      item("Neat Pad", "Neat Bar Pro"),
    ], { "template-a50": template });

    const rooms = file.nodes.filter((node) => node.type === "room");
    const devices = file.nodes.filter((node) => node.type === "device");

    expect(rooms.map((node) => node.data.label)).toEqual(["Yealink A50", "Neat Bar Pro"]);
    expect(devices.map((node) => node.parentId)).toEqual(["quote-room-1", "quote-room-1", "quote-room-2"]);
    expect(devices[0]?.data.ports).toHaveLength(1);
  });
});
