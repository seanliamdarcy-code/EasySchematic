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
