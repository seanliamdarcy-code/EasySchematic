import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlers } from "../mcpBridge";
import { useSchematicStore } from "../store";
import type { DeviceData, SchematicNode } from "../types";
import { collectColorKeyEntries } from "../colorKeyLayout";
import { areConnectorsCompatible, needsAdapter } from "../connectorTypes";

const s = () => useSchematicStore.getState();
const fixture = (id: string, direction: "input" | "output", x: number): SchematicNode => ({ id, type: "device", position: { x, y: 50 },
  data: { label: id, deviceType: "camera", ports: [{ id: `${id}-port`, label: "HDMI", direction, connectorType: "hdmi", signalType: "hdmi" }] } as DeviceData });
beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  s().newSchematic();
  useSchematicStore.setState({ nodes: [fixture("source", "output", 20), fixture("target", "input", 600)], edges: [], pages: [], customTemplates: [] });
  handlers.connect_devices({ sourceNodeId: "source", sourcePortId: "source-port", targetNodeId: "target", targetPortId: "target-port" });
});

describe("MCP layout controls", () => {
  it("creates exact feathers, parents them and interprets subsequent moves as room-relative", () => {
    const created = handlers.add_external_endpoints({ endpoints: [{ label: "NETWORK", x: 500, y: 1543, direction: "output", connectorType: "rj45", signalType: "ethernet" }] }) as { results: { result: { nodeId: string; position: { y: number }; portCoordinates: object[] } }[] };
    const endpoint = created.results[0].result;
    expect(endpoint.position.y).toBe(1543);
    expect(endpoint.portCoordinates).toHaveLength(1);
    const room = handlers.create_room({ label: "Room", x: 400, y: 1400, width: 600, height: 400 }) as { roomId: string };
    handlers.place_device_in_room({ deviceId: endpoint.nodeId, roomId: room.roomId, x: 60, y: 100 });
    expect(s().nodes.find(n => n.id === endpoint.nodeId)?.parentId).toBe(room.roomId);
    handlers.move_device({ nodeId: endpoint.nodeId, x: 80, y: 120 });
    expect(handlers.get_device({ nodeId: endpoint.nodeId })).toMatchObject({ parentId: room.roomId, position: { x: 80, y: 120 }, absoluteBounds: { x: 480, y: 1520 } });
    expect(() => handlers.place_device_in_room({ deviceId: endpoint.nodeId, roomId: room.roomId, x: -500, y: -500 })).toThrow();
    expect(s().nodes.find(n => n.id === endpoint.nodeId)?.parentId).toBe(room.roomId);
  });
  it("fits, moves and deletes rooms with children without losing topology and supports undo", () => {
    const room = handlers.create_room({ label: "Room", x: 0, y: 0, width: 400, height: 300 }) as { roomId: string };
    const edges = s().edges;
    const original = handlers.get_device({ nodeId: "source" }) as { absoluteBounds: object };
    const fit = handlers.update_room({ roomId: room.roomId, fitToChildren: true }) as { absoluteBounds: { x: number; y: number } };
    expect(handlers.get_device({ nodeId: "source" })).toMatchObject({ absoluteBounds: original.absoluteBounds });
    handlers.update_room({ roomId: room.roomId, x: fit.absoluteBounds.x + 100, y: fit.absoluteBounds.y + 200, label: "Moved" });
    expect(handlers.get_device({ nodeId: "source" })).toMatchObject({ absoluteBounds: { x: 120, y: 250 } });
    expect(s().edges).toBe(edges);
    handlers.delete_room({ roomId: room.roomId });
    expect(handlers.get_device({ nodeId: "source" })).toMatchObject({ absoluteBounds: { x: 120, y: 250 } });
    expect(s().nodes.find(n => n.id === "source")?.parentId).toBeUndefined();
    expect(s().edges).toHaveLength(1);
    s().undo();
    expect(s().nodes.find(n => n.id === "source")?.parentId).toBe(room.roomId);
  });
  it("allows ordinary different-plug cables while preserving adapter-only cases", () => {
    for (const pair of [["usb-a", "usb-c"], ["usb-a", "usb-b"], ["usb-c", "usb-b"], ["hdmi", "mini-hdmi"]] as const) {
      expect(areConnectorsCompatible(pair[0], pair[1])).toBe(true);
      expect(needsAdapter(pair[0], pair[1])).toBe(false);
    }
    expect(needsAdapter("hdmi", "dvi")).toBe(true);
    s().patchDeviceData("source", { ports: [{ id: "usb-a", label: "USB-A", connectorType: "usb-a", signalType: "usb", direction: "bidirectional" }] });
    s().patchDeviceData("target", { ports: [{ id: "usb-c", label: "USB-C", connectorType: "usb-c", signalType: "usb", direction: "bidirectional" }] });
    handlers.delete_connection({ connectionId: s().edges[0].id });
    expect(handlers.connect_devices({ sourceNodeId: "source", sourcePortId: "usb-a", sourceFace: "out", targetNodeId: "target", targetPortId: "usb-c", targetFace: "in" })).toMatchObject({ connected: true });
    expect(s().edges).toHaveLength(1);
  });
  it("sizes multiline notes and resizes without replacing rich text; validates before mutation", () => {
    const note = handlers.add_note({ text: Array(7).fill("Engineering notes").join("\n"), x: 400, y: 300, width: 420 }) as { noteId: string; height: number };
    expect(note.height).toBeGreaterThan(140);
    const html = s().nodes.find(n => n.id === note.noteId)?.data.html;
    handlers.update_note({ noteId: note.noteId, width: 500, height: 300 });
    expect(s().nodes.find(n => n.id === note.noteId)).toMatchObject({ style: { width: 500, height: 300 }, data: { html } });
    expect(() => handlers.update_note({ noteId: note.noteId, text: "Wrong", width: -1 })).toThrow();
    expect(s().nodes.find(n => n.id === note.noteId)?.data.html).toBe(html);
    s().undo();
    expect(s().nodes.find(n => n.id === note.noteId)?.style?.width).toBe(420);
  });
  it("selects the Tateside cells and persists custom merged legend labels", () => {
    handlers.configure_sheet({ titleBlockLayout: "tateside", titleBlock: { company: "Tateside", revision: "A", customFields: [
      { id: "drawing-no", label: "Drawing No.", value: "TS-AV-GMR-001" }, { id: "scale", label: "Scale", value: "NTS" }] }, legend: { labels: { ethernet: "CAT6 / TPX", expansion: "CAT6 / TPX" } }, signalColors: { ethernet: "#111111", expansion: "#111111" } });
    const fields = s().titleBlockLayout.cells.flatMap(c => c.content.type === "field" ? [c.content.field] : []);
    expect(fields).toEqual(expect.arrayContaining(["company", "revision", "drawing-no", "scale", "drawingTitle", "designer"]));
    expect(fields).not.toContain("engineer");
    const edges = ["ethernet", "expansion"].map((signalType, i) => ({ ...s().edges[0], id: String(i), data: { signalType } })) as ReturnType<typeof s>["edges"];
    expect(collectColorKeyEntries(edges, s().signalColors, undefined, undefined, s().colorKeyLabels)).toHaveLength(1);
    expect(s().exportToJSON().colorKeyLabels).toEqual({ ethernet: "CAT6 / TPX", expansion: "CAT6 / TPX" });
  });
  it("connects service references across connector types but still rejects different signals", () => {
    handlers.add_external_endpoints({ endpoints: [{ label: "SERVICE", x: 300, y: 300, direction: "output", signalType: "hdmi", connectorType: "usb-c" }] });
    const n = s().nodes.find(n => n.type === "device" && n.data.label === "SERVICE")!;
    handlers.delete_connection({ connectionId: s().edges[0].id });
    expect(handlers.connect_devices({ sourceNodeId: n.id, sourcePortId: "endpoint", targetNodeId: "target", targetPortId: "target-port" })).toMatchObject({ connected: true });
    expect(s().pendingIncompatibleConnection).toBeNull();
    handlers.delete_connection({ connectionId: s().edges[0].id });
    handlers.update_external_endpoint({ nodeId: n.id, signalType: "power" });
    expect(() => handlers.connect_devices({ sourceNodeId: n.id, sourcePortId: "endpoint", targetNodeId: "target", targetPortId: "target-port" })).toThrow();
    expect(s().edges).toHaveLength(0);
    // Physical plugs still need an adapter between real Devices.
    useSchematicStore.setState({ nodes: [fixture("physical", "output", 50), fixture("target", "input", 600)] });
    s().patchDeviceData("physical", { ports: [{ id: "physical-port", label: "USB-C", direction: "output", signalType: "hdmi", connectorType: "usb-c" }] });
    expect(() => handlers.connect_devices({ sourceNodeId: "physical", sourcePortId: "physical-port", targetNodeId: "target", targetPortId: "target-port" })).toThrow(/adapter/);
  });
  it("reports absolute Device bounds and Port coordinates inside rooms", () => {
    useSchematicStore.setState({ nodes: [{ id: "room", type: "room", position: { x: 400, y: 300 }, data: { label: "Room" } } as SchematicNode,
      { ...fixture("nested", "input", 50), parentId: "room", measured: { width: 180, height: 100 } }] });
    const result = handlers.get_device({ nodeId: "nested" });
    expect(result).toMatchObject({ position: { x: 50, y: 50 }, absoluteBounds: { x: 450, y: 350, w: 180, h: 100 }, geometryMeasured: true,
      portCoordinates: [{ portId: "nested-port", side: "left", absX: 450 }] });
    expect(handlers.get_schematic({})).toMatchObject({ devices: [{ absoluteBounds: { x: 450, y: 350 }, portCoordinates: [{ absX: 450 }] }] });
    s().patchDeviceData("nested", { ports: [{ id: "network", label: "LAN", direction: "bidirectional", signalType: "ethernet", connectorType: "rj45" }] });
    expect(handlers.get_device({ nodeId: "nested" })).toMatchObject({ portCoordinates: [
      { handleId: "network-in", side: "left", absX: 450 }, { handleId: "network-out", side: "right", absX: 630 },
    ] });
  });
  it("reports sheet geometry, previews/applies fit without moving Devices, and rejects invalid patches atomically", async () => {
    const nodes = s().nodes;
    const logo = "data:image/png;base64,fixture";
    expect(() => handlers.configure_sheet({ paperId: "iso-a3", offset: { x: NaN, y: 0 } })).toThrow();
    expect(() => handlers.configure_sheet({ titleBlock: { logo: "javascript:bad" } })).toThrow();
    const configured = handlers.configure_sheet({ paperId: "iso-a3", titleBlock: { logo }, offset: { x: -100, y: -100 }, legend: { enabled: true } });
    expect(configured).toMatchObject({ offset: { x: -100, y: -100 }, titleBlock: { logo }, pageCount: 1,
      pages: [{ rect: { x: -100, y: -100 }, drawingArea: { w: expect.any(Number) }, titleBlock: { h: expect.any(Number) }, legend: { w: expect.any(Number) } }] });
    const scale = s().printScale;
    expect(await handlers.configure_sheet({ fitToSheet: "preview" })).toMatchObject({ fit: { fits: true } });
    expect(s().printScale).toBe(scale);
    expect(await handlers.configure_sheet({ fitToSheet: "apply" })).toMatchObject({ pageCount: 1 });
    expect(s().nodes).toBe(nodes);
    useSchematicStore.setState({ nodes: [fixture("huge", "input", 0)], routedEdges: { huge: { waypoints: [{ x: 100000, y: 100000 }] } } as unknown as ReturnType<typeof s>["routedEdges"] });
    expect(await handlers.configure_sheet({ fitToSheet: "preview" })).toMatchObject({ fit: { fits: false } });
    await expect(handlers.configure_sheet({ fitToSheet: "apply" })).rejects.toThrow(/cannot fit/);
  });
  it("creates service endpoints independently, rejects invalid items and undoes creation", () => {
    const result = handlers.add_external_endpoints({ endpoints: [
      { label: "AV NETWORK", x: 300, y: 300, direction: "output", signalType: "ethernet", connectorType: "rj45" },
      { label: "bad", x: NaN, y: 20, direction: "output", signalType: "ethernet", connectorType: "rj45" },
    ] }) as { succeeded: number; failed: number };
    expect(result).toMatchObject({ succeeded: 1, failed: 1 });
    const n = s().nodes.find(n => n.type === "device" && n.data.label === "AV NETWORK")!;
    expect(n.data.ports).toMatchObject([{ id: "endpoint", direction: "output" }]);
    expect(s().customTemplates).toHaveLength(0);
    s().undo();
    expect(s().nodes.map(n => n.id)).toEqual(["source", "target"]);
  });
  it("renames only existing instance Ports while preserving links; validates atomically", () => {
    const edges = s().edges;
    handlers.rename_ports({ nodeId: "source", ports: [{ portId: "source-port", label: "HDMI O/P 1" }] });
    expect(s().edges).toBe(edges);
    expect((s().nodes[0].data as DeviceData).ports[0]).toMatchObject({ id: "source-port", label: "HDMI O/P 1", direction: "output", signalType: "hdmi" });
    const nodes = s().nodes;
    expect(() => handlers.rename_ports({ nodeId: "source", ports: [{ portId: "source-port", label: "bad edit" }, { portId: "missing", label: "bad" }] })).toThrow();
    expect(s().nodes).toBe(nodes);
    s().undo();
    expect((s().nodes[0].data as DeviceData).ports[0].label).toBe("HDMI");
  });
  it("protects connected endpoint hardware while permitting label edits", () => {
    handlers.add_external_endpoints({ endpoints: [{ label: "Laptop", x: 50, y: 200, signalType: "hdmi", connectorType: "hdmi", direction: "output" }] });
    const n = s().nodes.find(n => n.type === "device" && n.data.label === "Laptop")!;
    handlers.delete_connection({ connectionId: s().edges[0].id });
    handlers.connect_devices({ sourceNodeId: n.id, sourcePortId: "endpoint", targetNodeId: "target", targetPortId: "target-port" });
    const edges = s().edges;
    expect(() => handlers.update_external_endpoint({ nodeId: n.id, label: "Wrong", direction: "input" })).toThrow(/Disconnect/);
    expect(s().nodes.find(c => c.id === n.id)?.data.label).toBe("Laptop");
    handlers.update_external_endpoint({ nodeId: n.id, label: "CLIENT LAPTOP" });
    expect(s().edges).toBe(edges);
    expect(s().nodes.find(c => c.id === n.id)?.data.label).toBe("CLIENT LAPTOP");
  });
  it("rejects coerced enum values without changing the sheet", () => {
    const before = s().printOrientation;
    expect(() => handlers.configure_sheet({ orientation: ["portrait"] })).toThrow();
    expect(s().printOrientation).toBe(before);
    const result = handlers.add_external_endpoints({ endpoints: [{ label: "bad", x: 50, y: 200, signalType: "hdmi", connectorType: "hdmi", direction: ["output"] }] }) as { failed: number };
    expect(result.failed).toBe(1);
    expect(s().nodes).toHaveLength(2);
  });
  it("converts, moves, labels, restores and deletes paired stubs without orphaning anything", () => {
    const id = s().edges[0].id;
    handlers.set_connection_properties({ connectionId: id, properties: { cableId: "HD-001", label: "Video" } });
    handlers.set_connection_stubs({ connectionId: id, enabled: true });
    expect(s().edges).toHaveLength(2);
    let stubs = s().nodes.filter(n => n.type === "stub-label");
    expect(stubs).toHaveLength(2);
    handlers.set_connection_stubs({ connectionId: s().edges[0].id, enabled: true });
    expect(s().edges).toHaveLength(2);
    handlers.update_stub({ stubId: stubs[0].id, x: 400, y: 300, label: "TO DISPLAY", showPort: true });
    expect(s().nodes.find(n => n.id === stubs[0].id)).toMatchObject({ position: { x: 400, y: 300 }, data: { label: "TO DISPLAY", placed: true } });
    handlers.set_connection_properties({ connectionId: s().edges[1].id, properties: { cableId: "HD-002", color: "#8B1E3F" } });
    handlers.set_connection_stubs({ connectionId: s().edges[1].id, enabled: false });
    expect(s().edges).toHaveLength(1);
    expect(s().edges[0]).toMatchObject({ source: "source", target: "target", sourceHandle: "source-port", targetHandle: "target-port", data: { cableId: "HD-002", color: "#8B1E3F" } });
    expect(s().nodes.filter(n => n.type === "stub-label")).toHaveLength(0);
    handlers.set_connection_stubs({ connectionId: s().edges[0].id, enabled: true });
    handlers.delete_connection({ connectionId: s().edges[0].id });
    expect(s().edges).toHaveLength(0);
    expect(s().nodes).toHaveLength(2);
    s().undo();
    stubs = s().nodes.filter(n => n.type === "stub-label");
    expect(stubs).toHaveLength(2);
    expect(s().edges).toHaveLength(2);
  });
  it("keeps waypoints undoable and rejects malformed points before mutation", () => {
    const id = s().edges[0].id;
    handlers.set_connection_waypoints({ connectionId: id, waypoints: [{ x: 350, y: 80 }, { x: 350, y: 200 }] });
    expect(s().edges[0].data?.manualWaypoints).toHaveLength(2);
    const edges = s().edges;
    expect(() => handlers.set_connection_waypoints({ connectionId: id, waypoints: [{ x: Infinity, y: 80 }] })).toThrow();
    expect(s().edges).toBe(edges);
    handlers.set_connection_waypoints({ connectionId: id, waypoints: [] });
    expect(s().edges[0].data?.manualWaypoints).toBeUndefined();
    s().undo();
    expect(s().edges[0].data?.manualWaypoints).toHaveLength(2);
  });
  it("validates all sheet settings before writing and preserves omitted title fields", () => {
    const before = s().printPaperId;
    expect(() => handlers.configure_sheet({ paperId: "iso-a3", legend: { columns: 99 } })).toThrow();
    expect(s().printPaperId).toBe(before);
    const engineer = s().titleBlock.engineer;
    handlers.configure_sheet({ paperId: "iso-a3", orientation: "landscape", titleBlock: { drawingTitle: "Boardroom", revision: "B" }, legend: { enabled: true, columns: 2 } });
    expect(s().titleBlock).toMatchObject({ drawingTitle: "Boardroom", revision: "B", engineer });
    expect(handlers.configure_sheet({})).toMatchObject({ paperId: "iso-a3", legend: { enabled: true, columns: 2 } });
  });
});
