import { beforeEach, describe, expect, it } from "vitest";
import { handlers } from "../mcpBridge";
import { useSchematicStore } from "../store";
import type { DeviceData, SchematicNode } from "../types";

const s = () => useSchematicStore.getState();
const fixture = (id: string, direction: "input" | "output", x: number): SchematicNode => ({ id, type: "device", position: { x, y: 50 },
  data: { label: id, deviceType: "camera", ports: [{ id: `${id}-port`, label: "HDMI", direction, connectorType: "hdmi", signalType: "hdmi" }] } as DeviceData });
beforeEach(() => {
  s().newSchematic();
  useSchematicStore.setState({ nodes: [fixture("source", "output", 20), fixture("target", "input", 600)], edges: [], pages: [], customTemplates: [] });
  handlers.connect_devices({ sourceNodeId: "source", sourcePortId: "source-port", targetNodeId: "target", targetPortId: "target-port" });
});

describe("MCP layout controls", () => {
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
  it("reports sheet geometry, previews/applies fit without moving Devices, and rejects invalid patches atomically", () => {
    const nodes = s().nodes;
    const logo = "data:image/png;base64,fixture";
    expect(() => handlers.configure_sheet({ paperId: "iso-a3", offset: { x: NaN, y: 0 } })).toThrow();
    expect(() => handlers.configure_sheet({ titleBlock: { logo: "javascript:bad" } })).toThrow();
    const configured = handlers.configure_sheet({ paperId: "iso-a3", titleBlock: { logo }, offset: { x: -100, y: -100 }, legend: { enabled: true } });
    expect(configured).toMatchObject({ offset: { x: -100, y: -100 }, titleBlock: { logo }, pageCount: 1,
      pages: [{ rect: { x: -100, y: -100 }, drawingArea: { w: expect.any(Number) }, titleBlock: { h: expect.any(Number) }, legend: { w: expect.any(Number) } }] });
    const scale = s().printScale;
    expect(handlers.configure_sheet({ fitToSheet: "preview" })).toMatchObject({ fit: { fits: true } });
    expect(s().printScale).toBe(scale);
    expect(handlers.configure_sheet({ fitToSheet: "apply" })).toMatchObject({ pageCount: 1 });
    expect(s().nodes).toBe(nodes);
    useSchematicStore.setState({ nodes: [fixture("huge", "input", 0)], routedEdges: { huge: { waypoints: [{ x: 100000, y: 100000 }] } } as unknown as ReturnType<typeof s>["routedEdges"] });
    expect(handlers.configure_sheet({ fitToSheet: "preview" })).toMatchObject({ fit: { fits: false } });
    expect(() => handlers.configure_sheet({ fitToSheet: "apply" })).toThrow(/cannot fit/);
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
