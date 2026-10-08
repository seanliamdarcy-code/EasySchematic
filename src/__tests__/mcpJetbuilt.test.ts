import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlers } from "../mcpBridge";
import { useSchematicStore } from "../store";
import { importDevicesFromJetbuiltProject, searchJetbuiltProjects } from "../tatesideApi";
import { fetchTemplates } from "../templateApi";
import type { DeviceTemplate } from "../types";
import type { QuoteImportExtractionResponse, QuoteImportResultItem } from "../quoteImportTypes";

vi.mock("../tatesideApi", async (original) => ({ ...await original<typeof import("../tatesideApi")>(),
  importDevicesFromJetbuiltProject: vi.fn(), searchJetbuiltProjects: vi.fn() }));
vi.mock("../templateApi", async (original) => ({ ...await original<typeof import("../templateApi")>(), fetchTemplates: vi.fn() }));

const template: DeviceTemplate = { id: "codec", label: "Codec", manufacturer: "Fixture", modelNumber: "Codec", deviceType: "video-codec",
  ports: [{ id: "video", label: "HDMI Out", signalType: "hdmi", connectorType: "hdmi", direction: "output" }] };
const item = (model: string, room: string, matched = false): QuoteImportResultItem => ({ manufacturer: "Fixture", model, room,
  description: null, sourceLineText: null, normalizedLookupKey: model, quantity: 1, status: matched ? "already_in_library" : "missing",
  exactMatch: matched ? { id: "codec", label: "Codec", manufacturer: "Fixture", modelNumber: "Codec", normalizedLookupKey: "codec", matchReason: "exact" } : null,
  possibleMatches: [], portReuseCandidates: [] });
const extraction: QuoteImportExtractionResponse = { fileName: "P-TEST", fileType: "jetbuilt", extractedCount: 3, extractionModel: "fixture",
  extractionReasoningEffort: "low", warnings: [], results: [{ ...item("Codec", "Boardroom", true), quantity: 2 }, item("Missing", "Boardroom"), item("Lobby", "Lobby", true)] };
const preview = async () => await handlers.get_jetbuilt_project({ projectId: "project" }) as { previewId: string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useSchematicStore.getState().newSchematic();
  useSchematicStore.setState({ nodes: [], edges: [], pages: [], customTemplates: [], schematicName: "Existing" });
  vi.mocked(importDevicesFromJetbuiltProject).mockResolvedValue(structuredClone(extraction));
  vi.mocked(fetchTemplates).mockResolvedValue([template]);
  vi.mocked(searchJetbuiltProjects).mockResolvedValue([]);
});

describe("Jetbuilt through the editor bridge", () => {
  it("warns on mismatched reused Ports, overrides locally and maps placed Port ids", async () => {
    const corrected = { ...template, shortName: "Codec", category: "Processing", ports: [...template.ports,
      { id: "usb", label: "USB-C", signalType: "usb", connectorType: "usb-c", direction: "bidirectional" }] };
    const reused = await handlers.create_local_device({ template: corrected }) as { warnings: string[]; portIdMap: Record<string, string>; ports: { id: string }[] };
    expect(reused).toMatchObject({ reused: true, scope: "shared-existing" });
    expect(reused.warnings).toEqual(expect.arrayContaining([expect.stringContaining("different Ports"), expect.stringContaining("shortName")]));
    expect(reused.portIdMap.video).toBe(reused.ports[0].id);
    const overridden = await handlers.create_local_device({ template: corrected, overrideExisting: true }) as typeof reused;
    expect(overridden).toMatchObject({ reused: false, scope: "local", warnings: [] });
    expect(overridden.ports).toHaveLength(2);
    expect(overridden.portIdMap.usb).toBe(overridden.ports[1].id);
    expect(template.ports).toHaveLength(1);
    expect(useSchematicStore.getState().customTemplates).toHaveLength(1);
  });
  it("warns when reuse ignores a supplied model spelling and Device type", async () => {
    const result = await handlers.create_local_device({ template: { ...template, modelNumber: "C o d e c", deviceType: "monitor" } }) as { warnings: string[]; ignoredFields: string[]; nodeId: string };
    expect(result.ignoredFields).toEqual(["modelNumber", "deviceType"]);
    expect(result.warnings).toEqual([expect.stringContaining("modelNumber, deviceType")]);
    expect(handlers.get_device({ nodeId: result.nodeId })).toMatchObject({ modelNumber: "Codec", deviceType: "video-codec" });
  });
  it("searches and previews without changing the document", async () => {
    const before = useSchematicStore.getState().nodes;
    await handlers.search_jetbuilt_projects({ query: "P-TEST" });
    const result = await handlers.get_jetbuilt_project({ projectId: "project" }) as { rooms: { name: string }[]; items: { itemId: string }[] };
    expect(searchJetbuiltProjects).toHaveBeenCalledWith("P-TEST");
    expect(result.rooms.map((room) => room.name)).toEqual(["Boardroom", "Lobby"]);
    expect(result.items.map((entry) => entry.itemId)).toEqual(["item-1", "item-2", "item-3"]);
    expect(useSchematicStore.getState().nodes).toBe(before);
    expect(useSchematicStore.getState().schematicName).toBe("Existing");
  });

  it("imports only selected rooms and returns missing kit for research", async () => {
    const { previewId } = await preview();
    const result = await handlers.start_jetbuilt_schematic({ previewId, rooms: ["Boardroom"] }) as { deviceCount: number; notPlaced: { model: string }[] };
    const state = useSchematicStore.getState();
    expect(result.deviceCount).toBe(2);
    expect(result.notPlaced.map((entry) => entry.model)).toEqual(["Missing"]);
    expect(state.nodes.filter((entry) => entry.type === "room").map((entry) => entry.data.label)).toEqual(["Boardroom"]);
    expect(state.nodes.filter((entry) => entry.type === "device").every((entry) => entry.parentId === "quote-room-1")).toBe(true);
    expect(state.schematicName).toBe("P-TEST - Boardroom");
  });

  it("rejects invalid room/item selections and implicit replacement without mutation", async () => {
    const { previewId } = await preview();
    const before = useSchematicStore.getState().nodes;
    await expect(handlers.start_jetbuilt_schematic({ previewId, rooms: ["Invented"] })).rejects.toThrow(/Unknown room/);
    await expect(handlers.start_jetbuilt_schematic({ previewId, itemIds: ["invented"] })).rejects.toThrow(/Unknown itemId/);
    await expect(handlers.start_jetbuilt_schematic({ previewId, rooms: ["Boardroom"], itemIds: ["item-3"] })).rejects.toThrow(/No kit|outside/);
    expect(useSchematicStore.getState().nodes).toBe(before);
    await handlers.start_jetbuilt_schematic({ previewId, itemIds: ["item-1"] });
    const populated = useSchematicStore.getState().nodes;
    await expect(handlers.start_jetbuilt_schematic({ previewId })).rejects.toThrow(/not empty/);
    expect(useSchematicStore.getState().nodes).toBe(populated);
  });

  it("rejects a document change during the asynchronous library load", async () => {
    const { previewId } = await preview();
    let finish!: (templates: DeviceTemplate[]) => void;
    vi.mocked(fetchTemplates).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = handlers.start_jetbuilt_schematic({ previewId });
    useSchematicStore.setState({ nodes: [{ id: "user-room", type: "room", position: { x: 0, y: 0 }, data: { label: "User edit" } }] });
    finish([template]);
    await expect(pending).rejects.toThrow(/session changed/);
    expect(useSchematicStore.getState().nodes[0].id).toBe("user-room");
  });

  it("refuses unreviewed bundle components even when they have a library match", async () => {
    vi.mocked(importDevicesFromJetbuiltProject).mockResolvedValueOnce({ ...extraction,
      results: [{ ...extraction.results[0], bundleGroupId: "unreviewed" }] });
    const { previewId } = await preview();
    await expect(handlers.start_jetbuilt_schematic({ previewId })).rejects.toThrow(/unreviewed bundle/);
    expect(useSchematicStore.getState().nodes).toEqual([]);
  });

  it("imports missing-only room containers and refuses an expired preview", async () => {
    const first = await preview();
    const result = await handlers.start_jetbuilt_schematic({ previewId: first.previewId, itemIds: ["item-2"] }) as { deviceCount: number; roomCount: number };
    expect(result).toMatchObject({ deviceCount: 0, roomCount: 1 });
    for (let index = 0; index < 3; index++) await preview();
    await expect(handlers.start_jetbuilt_schematic({ previewId: first.previewId, replaceCurrent: true })).rejects.toThrow(/Preview expired/);
    expect(useSchematicStore.getState().nodes.map((entry) => entry.type)).toEqual(["room"]);
  });
});
