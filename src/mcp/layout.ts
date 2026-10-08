import { useSchematicStore } from "../store";
import { createExternalEndpointData, isExternalEndpointData } from "../externalEndpoint";
import { CONNECTOR_LABELS, SIGNAL_LABELS, SIGNAL_COLORS } from "../types";
import type { ConnectionData, DeviceData, Port, SignalType, TitleBlock } from "../types";
import { PAPER_SIZES } from "../printConfig";
import { runBatch, validatePosition } from "./validation";
import { MAX_BATCH_ITEMS } from "./protocol";
import { sheetGeometry, fitSheet } from "./sheet";
import { getPortAbsolutePositions } from "../snapUtils";
import { createTatesideLayout } from "../titleBlockLayout";

const state = () => useSchematicStore.getState();
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error(`${name} must be non-empty text, at most 2000 characters.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function position(x: unknown, y: unknown) {
  const result = validatePosition(x as number, y as number);
  if (!result.ok) throw new Error(result.error);
  return result.position;
}
function device(id: unknown) {
  const n = state().nodes.find(n => n.id === id && n.type === "device");
  if (!n || n.type !== "device") throw new Error("Device not found.");
  return n;
}
function edge(id: unknown) {
  const e = state().edges.find(e => e.id === id);
  if (!e) throw new Error("Connection not found.");
  return e;
}
function endpointPort(spec: Record<string, unknown>, original: Port): Port {
  const port = { ...original };
  if (spec.direction !== undefined) {
    if (!["input", "output", "bidirectional"].includes(spec.direction as string)) throw new Error("Invalid endpoint direction.");
    port.direction = spec.direction as Port["direction"];
  }
  if (spec.signalType !== undefined) {
    if (typeof spec.signalType !== "string" || !Object.hasOwn(SIGNAL_LABELS, spec.signalType)) throw new Error("Unknown signalType; use get_library_taxonomy.");
    port.signalType = spec.signalType as SignalType;
  }
  if (spec.connectorType !== undefined) {
    if (typeof spec.connectorType !== "string" || (!Object.hasOwn(CONNECTOR_LABELS, spec.connectorType) && !state().customConnectorTypes.includes(spec.connectorType))) throw new Error("Unknown connectorType.");
    port.connectorType = spec.connectorType as Port["connectorType"];
  }
  return port;
}
function sheetSummary() {
  const s = state();
  return { paperId: s.printPaperId, orientation: s.printOrientation, scale: s.printScale, titleBlock: s.titleBlock,
    titleBlockLayout: s.titleBlockLayout,
    deviceHeader: s.deviceHeader ?? { showManufacturerModel: false },
    offset: { x: s.printOriginOffsetX, y: s.printOriginOffsetY }, ...sheetGeometry(s),
    legend: { enabled: s.colorKeyEnabled, corner: s.colorKeyCorner, columns: s.colorKeyColumns, page: s.colorKeyPage, overrides: s.colorKeyOverrides, labels: s.colorKeyLabels }, signalColors: s.signalColors };
}

export const layoutHandlers = {
  add_external_endpoints: (params: Record<string, unknown>) => {
    const result = runBatch(params.endpoints, MAX_BATCH_ITEMS, (entry: Record<string, unknown>) => {
      const spec = object(entry);
      const label = text(spec.label, "label");
      const pos = position(spec.x, spec.y);
      for (const key of ["signalType", "connectorType", "direction"]) if (spec[key] === undefined) throw new Error(`${key} is required.`);
      const data = createExternalEndpointData(label);
      data.ports = [endpointPort(spec, data.ports[0])];
      const before = new Set(state().nodes.map(n => n.id));
      state().addExternalEndpoint(pos, data, true);
      const n = state().nodes.find(n => !before.has(n.id))!;
      return { nodeId: n.id, ports: data.ports, position: n.position, parentId: n.parentId,
        portCoordinates: getPortAbsolutePositions(n, new Map(state().nodes.map(n => [n.id, n]))) };
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  },
  update_external_endpoint: (params: Record<string, unknown>) => {
    const n = device(params.nodeId);
    if (!isExternalEndpointData(n.data) || n.data.ports.length !== 1) throw new Error("Device is not a compact external endpoint.");
    const data: DeviceData = { ...n.data, ports: [endpointPort(params, n.data.ports[0])] };
    if (params.label !== undefined) data.label = text(params.label, "label");
    // Connected endpoints retain their electrical identity; labels and positions remain editable.
    if (state().edges.some(e => e.source === n.id || e.target === n.id) && ["direction", "signalType", "connectorType"].some(k => data.ports[0][k as keyof Port] !== n.data.ports[0][k as keyof Port])) throw new Error("Disconnect the endpoint before changing its direction, signal or connector.");
    const pos = params.x !== undefined || params.y !== undefined ? position(params.x, params.y) : undefined;
    state().patchDeviceData(n.id, data);
    if (pos) state().moveDevice(n.id, pos);
    return { nodeId: n.id, ports: data.ports };
  },
  rename_ports: (params: Record<string, unknown>) => {
    const n = device(params.nodeId);
    if (!Array.isArray(params.ports) || !params.ports.length || params.ports.length > 500) throw new Error("ports must contain 1–500 label edits.");
    const edits = new Map<string, string>();
    for (const entry of params.ports) {
      const p = object(entry);
      const id = text(p.portId, "portId");
      if (!n.data.ports.some(p => p.id === id) || edits.has(id)) throw new Error(`Unknown or duplicate portId: ${id}`);
      edits.set(id, text(p.label, "label"));
    }
    state().patchDeviceData(n.id, { ports: n.data.ports.map(p => edits.has(p.id) ? { ...p, label: edits.get(p.id)! } : p) });
    return { nodeId: n.id, ports: device(n.id).data.ports };
  },
  set_connection_stubs: (params: Record<string, unknown>) => {
    const e = edge(params.connectionId);
    if (typeof params.enabled !== "boolean") throw new Error("enabled must be boolean.");
    if (params.enabled) {
      if (!e.data?.linkedConnectionId) { device(e.source); device(e.target); state().convertEdgeToStubs(e.id); }
    } else state().collapseStubsForEdge(e.id);
    return { connections: state().edges, stubs: state().nodes.filter(n => n.type === "stub-label") };
  },
  update_stub: (params: Record<string, unknown>) => {
    const n = state().nodes.find(n => n.id === params.stubId && n.type === "stub-label");
    if (!n) throw new Error("Stub not found.");
    const patch: { label?: string; showPort?: boolean; showRoom?: boolean; pageMode?: "always" | "cross-page" | "never" } = {};
    if (params.label !== undefined) {
      if (params.label === "") patch.label = undefined;
      else patch.label = text(params.label, "label");
    }
    for (const k of ["showPort", "showRoom"] as const) if (params[k] !== undefined) {
      if (typeof params[k] !== "boolean") throw new Error(`${k} must be boolean.`);
      patch[k] = params[k];
    }
    if (params.pageMode !== undefined) {
      if (!["always", "cross-page", "never"].includes(params.pageMode as string)) throw new Error("Invalid pageMode.");
      patch.pageMode = params.pageMode as typeof patch.pageMode;
    }
    const pos = params.x !== undefined || params.y !== undefined ? position(params.x, params.y) : undefined;
    if (pos) state().moveStubLabel(n.id, pos);
    state().patchStubLabelData(n.id, patch);
    return state().nodes.find(s => s.id === n.id);
  },
  set_connection_properties: (params: Record<string, unknown>) => {
    const e = edge(params.connectionId);
    const properties = object(params.properties);
    const patch: Partial<ConnectionData> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!["label", "sourceLabel", "targetLabel", "cableId", "cableLength", "multicableLabel", "color", "lineStyle"].includes(key)) throw new Error(`Unsupported Connection property: ${key}`);
      if (typeof value !== "string" || value.length > 2000) throw new Error(`${key} must be text, at most 2000 characters.`);
      if (key === "lineStyle" && !["solid", "dashed", "dotted", "dash-dot"].includes(value)) throw new Error("Invalid lineStyle.");
      if (key === "color" && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("color must be #RRGGBB.");
      patch[key] = value;
    }
    if (e.data?.linkedConnectionId) {
      const legs = state().edges.filter(c => c.data?.linkedConnectionId === e.data!.linkedConnectionId);
      const canonical = legs.find(c => state().nodes.find(n => n.id === c.source)?.type !== "stub-label");
      if (!canonical) throw new Error("Incomplete stub pair; repair it in the editor.");
      const appearance = { ...patch };
      for (const key of ["cableId", "label", "cableLength", "multicableLabel"]) delete appearance[key];
      state().batchPatchEdgeData(legs.map(c => ({ edgeId: c.id, patch: c.id === canonical.id ? patch : appearance })));
    } else state().patchEdgeData(e.id, patch);
    return edge(e.id);
  },
  set_connection_waypoints: (params: Record<string, unknown>) => {
    const e = edge(params.connectionId);
    if (!Array.isArray(params.waypoints) || params.waypoints.length > 100) throw new Error("waypoints must be an array of at most 100 points.");
    const points = params.waypoints.map(p => { const point = object(p); return position(point.x, point.y); });
    if (points.length) state().setManualWaypoints(e.id, points);
    else state().clearManualWaypoints(e.id);
    return edge(e.id);
  },
  configure_sheet: (params: Record<string, unknown>) => {
    const deviceHeader = params.deviceHeader === undefined ? undefined : object(params.deviceHeader);
    if (deviceHeader) for (const [key, value] of Object.entries(deviceHeader)) {
      if (!["showManufacturerModel", "showDeviceType"].includes(key) || typeof value !== "boolean") throw new Error("deviceHeader accepts only boolean showManufacturerModel/showDeviceType.");
    }
    if (params.titleBlockLayout !== undefined && params.titleBlockLayout !== "tateside") throw new Error("titleBlockLayout must be tateside.");
    const offset = params.offset === undefined ? undefined : object(params.offset);
    if (offset) position(offset.x, offset.y);
    if (params.fitToSheet !== undefined && !["preview", "apply"].includes(params.fitToSheet as string)) throw new Error("fitToSheet must be preview or apply.");
    if (params.fitToSheet !== undefined && (Object.keys(params).length !== 1)) throw new Error("Use fitToSheet separately after configuring the sheet.");
    if (params.fitToSheet !== undefined) {
      return (async () => {
        const { loadSeq, activePage } = state();
        // The router debounces geometry changes by 50ms; old routes can inflate the fit.
        await new Promise(resolve => setTimeout(resolve, 100));
        const deadline = Date.now() + 5000;
        while (state().isRouting) {
          if (Date.now() > deadline) throw new Error("Routing is still running; retry fit after it finishes.");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (state().loadSeq !== loadSeq || state().activePage !== activePage) throw new Error("Editor session changed; retry fit.");
        const fit = fitSheet();
        if (params.fitToSheet === "apply") {
          if (!fit.fits) throw new Error("Content cannot fit at the minimum scale; use larger paper or reduce content.");
          state().setPrintScale(fit.scale);
          state().setPrintOriginOffset(fit.offset.x, fit.offset.y);
        }
        return { ...sheetSummary(), fit };
      })();
    }
    if (params.paperId !== undefined && !PAPER_SIZES.some(p => p.id === params.paperId)) throw new Error("Unknown paperId.");
    if (params.orientation !== undefined && !["landscape", "portrait"].includes(params.orientation as string)) throw new Error("Invalid orientation.");
    if (params.scale !== undefined && (typeof params.scale !== "number" || !Number.isFinite(params.scale) || params.scale < 0.25 || params.scale > 2)) throw new Error("scale must be between 0.25 and 2.");
    const tb = { ...state().titleBlock };
    if (params.titleBlock !== undefined) for (const [key, value] of Object.entries(object(params.titleBlock))) {
      if (key === "logo") {
        if (typeof value !== "string" || value.length > 2_000_000 || (value !== "" && !/^(https?:\/\/|\/[^/]|data:image\/(png|jpeg|webp|svg\+xml)[;,])/i.test(value))) throw new Error("logo must be an image URL, /asset path, image data URI, or empty text to clear.");
        tb.logo = value;
        continue;
      }
      if (key === "customFields") {
        if (!Array.isArray(value) || value.length > 50) throw new Error("customFields must be an array of at most 50 fields.");
        const ids = new Set<string>();
        tb.customFields = value.map(entry => {
          const f = object(entry);
          const id = text(f.id, "custom field id");
          if (ids.has(id)) throw new Error("Duplicate custom field id.");
          ids.add(id);
          return { id, label: text(f.label, "custom field label"), value: text(f.value, "custom field value") };
        });
        continue;
      }
      if (!["showName", "venue", "designer", "engineer", "date", "drawingTitle", "company", "revision"].includes(key) || typeof value !== "string" || value.length > 2000) throw new Error(`Invalid titleBlock field: ${key}`);
      tb[key as keyof Omit<TitleBlock, "customFields">] = value;
    }
    const legend = params.legend === undefined ? {} : object(params.legend);
    for (const key of Object.keys(legend)) if (!["enabled", "corner", "columns", "page", "labels"].includes(key)) throw new Error(`Unknown legend field: ${key}`);
    const labels = legend.labels === undefined ? undefined : object(legend.labels);
    if (labels) for (const [key, value] of Object.entries(labels)) {
      if (!Object.hasOwn(SIGNAL_LABELS, key) || typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("legend.labels must map known signals to non-empty labels up to 100 characters.");
    }
    if (legend.enabled !== undefined && typeof legend.enabled !== "boolean") throw new Error("legend.enabled must be boolean.");
    if (legend.corner !== undefined && !["top-left", "top-right", "bottom-left", "bottom-right"].includes(legend.corner as string)) throw new Error("Invalid legend corner.");
    if (legend.columns !== undefined && (typeof legend.columns !== "number" || !Number.isInteger(legend.columns) || legend.columns < 1 || legend.columns > 4)) throw new Error("legend.columns must be 1–4.");
    if (legend.page !== undefined && !["first", "last", "all"].includes(legend.page as string)) throw new Error("Invalid legend page.");
    const colors = { ...SIGNAL_COLORS, ...state().signalColors };
    if (params.signalColors !== undefined) for (const [key, value] of Object.entries(object(params.signalColors))) {
      if (!Object.hasOwn(SIGNAL_LABELS, key) || typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("signalColors must map known signal types to #RRGGBB.");
      colors[key as SignalType] = value;
    }
    // Validate the complete request before applying any settings.
    const s = state();
    if (deviceHeader) s.setDeviceHeader({ ...s.deviceHeader, ...deviceHeader });
    if (params.paperId !== undefined) s.setPrintPaperId(params.paperId as string);
    if (params.orientation !== undefined) s.setPrintOrientation(params.orientation as "landscape" | "portrait");
    if (params.scale !== undefined) s.setPrintScale(params.scale as number);
    if (offset) s.setPrintOriginOffset(offset.x as number, offset.y as number);
    if (params.titleBlock !== undefined) s.setTitleBlock(tb);
    if (params.titleBlockLayout === "tateside") s.setTitleBlockLayout(createTatesideLayout(tb));
    if (params.signalColors !== undefined) s.setSignalColors(colors);
    if (legend.enabled !== undefined) s.setColorKeyEnabled(legend.enabled as boolean);
    if (legend.corner !== undefined) s.setColorKeyCorner(legend.corner as typeof s.colorKeyCorner);
    if (legend.columns !== undefined) s.setColorKeyColumns(legend.columns as number);
    if (legend.page !== undefined) s.setColorKeyPage(legend.page as typeof s.colorKeyPage);
    if (labels) s.setColorKeyLabels(labels as Partial<Record<SignalType, string>>);
    return sheetSummary();
  },
};

export { sheetSummary };
