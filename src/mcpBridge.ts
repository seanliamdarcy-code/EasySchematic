/**
 * In-app side of the EasySchematic MCP bridge (Beta).
 *
 * A small WebSocket *client* that connects to the standalone MCP server
 * (`mcp-server/`) running on localhost. It receives tool commands from Claude
 * and executes each by calling the EXISTING store actions — so undo, autosave,
 * validation and auto-routing all keep working unchanged. It never opens a
 * listening socket and only connects when the user turns on the Beta setting and
 * supplies the pairing token.
 *
 * Security: the connection is gated by a pairing token (sent in the handshake)
 * and the server additionally checks the request Origin. Both must pass before
 * any command runs.
 */
import { useEffect } from "react";
import type { Connection } from "@xyflow/react";
import { resolveDeviceHeader } from "./displayName";
import { transformLabelNow } from "./labelCaseUtils";
import { useSchematicStore } from "./store";
import { absRect, getPortAbsolutePositions } from "./snapUtils";
import { roomHandlers } from "./mcp/rooms";
import { getBundledTemplates, getTemplateById, getCardsByFamily, fetchTemplates } from "./templateApi";
import { inferRackForm, inferRackHeightU } from "./rackUtils";
import {
  DEFAULT_BRIDGE_PORT,
  PROTOCOL_VERSION,
  MAX_BATCH_ITEMS,
  type CommandType,
  type BridgeServerMessage,
  type AddDeviceParams,
  type AddDevicesParams,
  type SetDevicePropertyParams,
  type ConnectDevicesParams,
  type ConnectDevicesBatchParams,
  type GetDeviceParams,
  type SearchTemplatesParams,
  type DeleteDeviceParams,
  type MoveDeviceParams,
  type DeleteConnectionParams,
  type CreateRoomParams,
  type PlaceDeviceInRoomParams,
  type AddNoteParams,
  type ListSlotCardsParams,
  type InstallCardParams,
  type RemoveCardParams,
  type CreateRackParams,
  type PlaceDeviceInRackParams,
  type RemoveDeviceFromRackParams,
  type UpdateNoteParams,
  type DeleteNoteParams,
  type InstallCardBatchParams,
  type PlaceDeviceInRackBatchParams,
  type PortFace,
} from "./mcp/protocol";
import {
  classifyDeviceProperties,
  resolveHandleFromCandidates,
  validatePosition,
  validateRoomSize,
  planConnectionRemoval,
  runBatch,
  noteTextToHtml,
  noteHtmlToText,
  validateCardForSlot,
  validateUPosition,
  validateRackFace,
  validateRackSpec,
} from "./mcp/validation";
import type {
  DeviceData,
  DeviceTemplate,
  InstalledSlot,
  Port,
  RackData,
  RackDevicePlacement,
  RackElevationPage,
  SchematicNode,
} from "./types";

import { fetchTaxonomyRegistry, proposeMissingDevice, getLibraryDoctorProposal, getLibraryDoctorProposalHistory, searchJetbuiltProjects, importDevicesFromJetbuiltProject } from "./tatesideApi";
import type { QuoteImportExtractionResponse } from "./quoteImportTypes";
import { buildQuoteImportSchematic, importRoomLabel } from "./import/quoteSchematic";
import { refreshTemplates } from "./templateApi";
import { validateDeviceTemplate, normalizeDeviceTemplate } from "./deviceTemplateValidation";
import { CONNECTOR_LABELS, SIGNAL_LABELS } from "./types";
import { layoutHandlers, sheetSummary } from "./mcp/layout";
import { captureCanvas } from "./exportUtils";

export type BridgeStatus = "off" | "connecting" | "connected" | "error";

/** Raised inside a command handler to return ok:false with a readable message. */
class CommandError extends Error {}

// Previews are bounded, tab-local and never persisted. Import exactly what staff reviewed.
const jetbuiltPreviews = new Map<string, { projectId: string; extraction: QuoteImportExtractionResponse }>();
function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CommandError(`${name} must be a non-empty string.`);
  return value.trim();
}
function selectedStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new CommandError(`${name} must contain between 1 and 1000 values.`);
  return value.map((entry) => requiredText(entry, name));
}

function st() {
  return useSchematicStore.getState();
}

function setStatus(status: BridgeStatus, detail?: string) {
  useSchematicStore.setState({ mcpBridgeStatus: status, mcpBridgeStatusDetail: detail });
}

function deviceNodes(): SchematicNode[] {
  return st().nodes.filter((n) => n.type === "device");
}

function requireDevice(nodeId: string): SchematicNode {
  const node = st().nodes.find((n) => n.id === nodeId);
  if (!node) throw new CommandError(`No device found with id "${nodeId}".`);
  if (node.type !== "device") throw new CommandError(`Node "${nodeId}" is not a device.`);
  return node;
}

function portSummary(p: Port) {
  return { id: p.id, label: p.label, direction: p.direction, signalType: p.signalType, connectorType: p.connectorType, section: p.section };
}

/** Compact view of a room (container) node for get_schematic. `parentId`/`position`
 *  follow the same frame convention as devices — position is room-relative when the room
 *  is nested inside another room. Size follows the same `measured ?? width ?? style ??
 *  default` chain the rest of the app uses (snapUtils.nodeRect), so a room whose live
 *  measured size differs from its style isn't misreported; defaults mirror addRoom (400x300). */
function roomSummary(n: SchematicNode) {
  const style = (n.style ?? {}) as { width?: number; height?: number };
  return {
    roomId: n.id,
    label: (n.data as { label?: string }).label,
    position: n.position,
    parentId: n.parentId,
    width: n.measured?.width ?? (n.width as number | undefined) ?? style.width ?? 400,
    height: n.measured?.height ?? (n.height as number | undefined) ?? style.height ?? 300,
  };
}

/** Compact view of a note (sticky-note) node for get_schematic. `text` is a best-effort
 *  plain-text rendering of the note's stored HTML (see noteHtmlToText). `parentId` is
 *  reported because a note can be reparented into a room, making `position` room-relative. */
function noteSize(params: Record<string, unknown>, text: string, current?: SchematicNode) {
  const width = params.width ?? current?.measured?.width ?? current?.width ?? current?.style?.width ?? 400;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 120 || width > 10000) throw new CommandError("Note width must be between 120 and 10000.");
  // Conservative text estimate at the editor's 11px font, including wrapped lines.
  const lines = text.replace(/\r\n?/g, "\n").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * 11 / (width - 16))), 0);
  const height = params.height ?? Math.max(100, lines * 18 + 16, Number(current?.measured?.height ?? current?.height ?? current?.style?.height ?? 0));
  if (typeof height !== "number" || !Number.isFinite(height) || height < 60 || height > 10000) throw new CommandError("Note height must be between 60 and 10000.");
  if (params.height !== undefined && height < lines * 18 + 16) throw new CommandError("Note height is too small for its text; increase it or omit height for automatic sizing.");
  return { width, height };
}

function noteSummary(n: SchematicNode) {
  return {
    noteId: n.id,
    text: noteHtmlToText((n.data as { html?: string }).html ?? ""),
    position: n.position,
    parentId: n.parentId,
    width: n.measured?.width ?? n.width ?? n.style?.width ?? 200,
    height: n.measured?.height ?? n.height ?? n.style?.height ?? 100,
  };
}

/** Find a note node by id, or throw a readable CommandError (mirrors requireDevice). */
function requireNote(noteId: string): SchematicNode {
  const node = st().nodes.find((n) => n.id === noteId);
  if (!node) throw new CommandError(`No note found with id "${noteId}".`);
  if (node.type !== "note") throw new CommandError(`Node "${noteId}" is not a note.`);
  return node;
}

/** Compact view of a device's modular slot, for get_device. `filled` is the quick
 *  flag; cardTemplateId/cardLabel describe the installed card (absent when empty). */
function slotSummary(s: InstalledSlot) {
  return {
    slotId: s.slotId,
    label: s.label,
    slotFamily: s.slotFamily,
    parentSlotId: s.parentSlotId,
    filled: Boolean(s.cardTemplateId),
    cardTemplateId: s.cardTemplateId,
    cardLabel: s.cardLabel,
  };
}

/** Find an installed slot on a device, or throw a readable CommandError. Used by the
 *  slot tools so they fully pre-validate before touching the structural swapCard
 *  action (which pushes an undo entry before its own guards). */
function requireSlot(device: SchematicNode, slotId: string): InstalledSlot {
  const slot = ((device.data as DeviceData).slots ?? []).find((s) => s.slotId === slotId);
  if (!slot) {
    throw new CommandError(`No slot found with id "${slotId}" on device "${device.id}".`);
  }
  return slot;
}

/** All rack-elevation pages in the schematic (racks live on their own page type,
 *  separate from the main device graph). */
function rackPages(): RackElevationPage[] {
  return st().pages.filter((p): p is RackElevationPage => p.type === "rack-elevation");
}

/** Compact view of a rack device placement, resolving the device's current label and
 *  inferred U height from its node. deviceLabel/heightU are null when the placement
 *  points at a node that no longer exists. */
function rackPlacementSummary(pl: RackDevicePlacement) {
  const data = st().nodes.find((n) => n.id === pl.deviceNodeId)?.data as DeviceData | undefined;
  return {
    placementId: pl.id,
    deviceNodeId: pl.deviceNodeId,
    deviceLabel: data?.label ?? null,
    uPosition: pl.uPosition,
    face: pl.face,
    halfRackSide: pl.halfRackSide,
    mountedOnShelfId: pl.mountedOnShelfId,
    heightU: data ? inferRackHeightU(data) : null,
  };
}

/** Resolve the rack-elevation page + rack for a rackId, failing on zero or multiple
 *  matches rather than guessing. Rack ids are intended to be unique; a duplicate means
 *  the file is already inconsistent, and silently mutating the first match would risk
 *  touching the wrong rack. */
function requireRack(rackId: string): { page: RackElevationPage; rack: RackData } {
  const matches: { page: RackElevationPage; rack: RackData }[] = [];
  for (const page of rackPages()) {
    for (const rack of page.racks) {
      if (rack.id === rackId) matches.push({ page, rack });
    }
  }
  if (matches.length === 0) throw new CommandError(`No rack found with id "${rackId}". Call list_racks first.`);
  if (matches.length > 1) throw new CommandError(`Rack id "${rackId}" is ambiguous (matches ${matches.length} racks).`);
  return matches[0];
}

/** Resolve the rack-elevation page + placement for a placementId, failing on zero or
 *  multiple matches (same reasoning as requireRack). */
function requirePlacement(placementId: string): { page: RackElevationPage; placement: RackDevicePlacement } {
  const matches: { page: RackElevationPage; placement: RackDevicePlacement }[] = [];
  for (const page of rackPages()) {
    for (const placement of page.placements) {
      if (placement.id === placementId) matches.push({ page, placement });
    }
  }
  if (matches.length === 0) throw new CommandError(`No rack placement found with id "${placementId}". Call list_racks first.`);
  if (matches.length > 1) throw new CommandError(`Placement id "${placementId}" is ambiguous (matches ${matches.length}).`);
  return matches[0];
}

/** The full discoverable set: the live community library (which already has the
 *  bundled fallback merged as a floor) plus this schematic's custom templates,
 *  de-duped by key. fetchTemplates() is internally cached, so repeated calls are
 *  cheap; on a network failure it falls back to the bundled subset. */
async function allTemplates(): Promise<DeviceTemplate[]> {
  const loadSeq = st().loadSeq;
  const enabled = st().mcpBridgeEnabled;
  const token = st().mcpBridgeToken;
  const port = st().mcpBridgePort;
  const office = st().mcpBridgeOffice;
  const page = st().activePage;
  let library: DeviceTemplate[];
  try {
    library = await fetchTemplates();
  } catch {
    library = getBundledTemplates();
  }
  if (st().loadSeq !== loadSeq || st().mcpBridgeEnabled !== enabled || st().mcpBridgeToken !== token || st().mcpBridgePort !== port || st().mcpBridgeOffice !== office || st().activePage !== page) throw new CommandError("Editor session changed; retry the command.");
  const merged = new Map<string, DeviceTemplate>();
  for (const t of [...library, ...st().customTemplates]) {
    merged.set(t.id ?? t.deviceType, t);
  }
  return [...merged.values()];
}

function resolveTemplate(templateId: string, list: DeviceTemplate[]): DeviceTemplate | undefined {
  return (
    getTemplateById(templateId, st().customTemplates) ??
    list.find((t) => (t.id ?? t.deviceType) === templateId) ??
    list.find((t) => t.deviceType === templateId)
  );
}

/** Resolve a (portId, face) to the React Flow handle id the UI would use, by
 *  asking the same geometry helper that lays out the node's handles. */
function deviceGeometry(node: SchematicNode) {
  const s = st();
  const nodeMap = new Map(s.nodes.map(n => [n.id, n]));
  const rect = absRect(node, nodeMap);
  return {
    absoluteBounds: { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top },
    geometryMeasured: node.measured?.width !== undefined && node.measured?.height !== undefined,
    portCoordinates: getPortAbsolutePositions(node, nodeMap, s),
  };
}

function resolveHandle(node: SchematicNode, portId: string, face: PortFace | undefined): string {
  const nodeMap = new Map(st().nodes.map((n) => [n.id, n] as const));
  const candidates = getPortAbsolutePositions(node, nodeMap)
    .filter((h) => h.portId === portId)
    .map((h) => h.handleId);
  const res = resolveHandleFromCandidates(candidates, portId, face);
  if (!res.ok) throw new CommandError(res.error);
  return res.handleId;
}

// ---------------------------------------------------------------------------
// Shared cores — one device / one connection. Used by both the singular tools and
// the batch tools (add_devices / connect_devices_batch), so the two stay identical.
// Each throws CommandError on failure.
// ---------------------------------------------------------------------------
function addDeviceCore(spec: AddDeviceParams, templates: DeviceTemplate[]) {
  const { templateId, label, x, y } = spec;
  if (!templateId) throw new CommandError("templateId is required.");
  const tpl = resolveTemplate(templateId, templates);
  if (!tpl) throw new CommandError(`No template found for "${templateId}". Use search_templates first.`);
  const position = { x: x ?? 0, y: y ?? 0 };
  const before = new Set(st().nodes.map((n) => n.id));
  st().addDevice(tpl, position);
  const added = st().nodes.find((n) => !before.has(n.id));
  if (!added) throw new CommandError("Device was not added (no new node appeared).");
  const renamed = Boolean(label && label !== tpl.label);
  if (renamed) st().updateDeviceLabel(added.id, label!);
  // Report the final label — `added` was captured before the rename, so read the
  // applied custom label rather than the stale template label.
  return { nodeId: added.id, label: renamed ? label! : (added.data as DeviceData).label, position };
}

function connectDevicesCore(p: ConnectDevicesParams) {
  const sourceNode = requireDevice(p.sourceNodeId);
  const targetNode = requireDevice(p.targetNodeId);
  const sourceHandle = resolveHandle(sourceNode, p.sourcePortId, p.sourceFace);
  const targetHandle = resolveHandle(targetNode, p.targetPortId, p.targetFace);
  const connection: Connection = {
    source: p.sourceNodeId,
    sourceHandle,
    target: p.targetNodeId,
    targetHandle,
  };
  if (!st().isValidConnection(connection)) {
    throw new CommandError(
      `That connection is not valid (incompatible direction/signal, duplicate, or self-connection).`,
    );
  }
  const before = new Set(st().edges.map((e) => e.id));
  st().onConnect(connection);
  const edge = st().edges.find((e) => !before.has(e.id));
  if (!edge) {
    // isValidConnection passed, but onConnect can still bail into the
    // incompatible-connection flow (connector/signal needs an adapter, or there
    // are zero/multiple adapter matches), leaving a pending UI prompt and no
    // edge. Clear that pending state and report honestly rather than claiming
    // a connection that never happened.
    useSchematicStore.setState({ pendingIncompatibleConnection: null });
    throw new CommandError(
      "Connection was not created — these ports are incompatible and need an adapter device between them.",
    );
  }
  return { connected: true, edgeId: edge.id, sourceHandle, targetHandle };
}

/** Install one expansion card into an empty slot. Shared by install_card and
 *  install_card_batch so the two behave identically. Fully pre-validates (device/slot
 *  exist, slot empty, card resolves the way swapCard will, family matches) before the
 *  structural swapCard, then re-reads to confirm. Throws CommandError on any failure. */
function installCardCore(p: InstallCardParams) {
  const { deviceId, slotId, cardTemplateId } = p;
  const device = requireDevice(deviceId);
  const slot = requireSlot(device, slotId);
  // Refuse to overwrite a filled slot: swapCard would replace the card and drop its
  // ports + connected connections. Make the AI remove_card first so that loss is
  // explicit, never silent.
  if (slot.cardTemplateId) {
    throw new CommandError(
      `Slot "${slotId}" already holds a card ("${slot.cardLabel ?? slot.cardTemplateId}"). ` +
        `Remove it first with remove_card, then install.`,
    );
  }
  if (!cardTemplateId) throw new CommandError("cardTemplateId is required.");
  // Resolve exactly the way swapCard will (getTemplateById over the current library
  // view + custom templates), so a card we accept is one swapCard can actually find.
  const card = getTemplateById(cardTemplateId, st().customTemplates);
  if (!card) {
    throw new CommandError(
      `No card template found for "${cardTemplateId}". Call list_slot_cards (or ` +
        `search_templates to load the full library) first.`,
    );
  }
  const compat = validateCardForSlot(slot.slotFamily, card.slotFamily);
  if (!compat.ok) throw new CommandError(compat.error);
  if (!card.id) throw new CommandError(`Card template "${cardTemplateId}" has no id and cannot be installed.`);
  st().swapCard(deviceId, slotId, card.id);
  // Confirm by re-reading the slot (swapCard returns void); guards against any
  // residual resolution mismatch rather than reporting a blind success. NOTE: this is
  // the one throw that fires AFTER swapCard (which pushes undo before mutating), so it is
  // the single exception to install_card_batch's "a failed item changes nothing" contract
  // — but it is a defensive guard against a swapCard regression, not a reachable path
  // given the pre-validation above (slot empty, card resolves, family matches). All the
  // ordinary install_card failures throw before swapCard, so a failed batch item normally
  // leaves no mutation and no undo step.
  const after = requireSlot(requireDevice(deviceId), slotId);
  if (after.cardTemplateId !== card.id) {
    throw new CommandError(`Card "${card.id}" could not be installed into slot "${slotId}".`);
  }
  return {
    deviceId,
    slotId,
    cardTemplateId: card.id,
    cardLabel: after.cardLabel,
    portIds: after.portIds,
  };
}

/** Mount one device into a rack at a U position. Shared by place_device_in_rack and
 *  place_device_in_rack_batch. Pre-checks isRackSlotAvailable (the store action does NOT)
 *  and the editor's one-rack / 2-post-rear / oversize / shelf-only rules before the
 *  structural addPlacementSmart. Throws CommandError on any failure. */
function placeDeviceInRackCore(p: PlaceDeviceInRackParams) {
  const { deviceId, rackId, uPosition, face } = p;
  const node = requireDevice(deviceId);
  const data = node.data as DeviceData;
  const { page, rack } = requireRack(rackId);
  const f = validateRackFace(face);
  if (!f.ok) throw new CommandError(f.error);
  const u = validateUPosition(uPosition);
  if (!u.ok) throw new CommandError(u.error);

  // 2-post frames have no rear face (mirrors the editor's isRackRearBlocked).
  if (f.face === "rear" && rack.rackType === "open-2post") {
    throw new CommandError(`Rack "${rackId}" is a 2-post frame, which has no rear face — use face "front".`);
  }

  // A device is placed in at most one rack at a time: the editor hides "Place in Rack"
  // once a device is placed and excludes already-placed devices from auto-fill, but the
  // store does not enforce singularity. Reject a duplicate placement explicitly.
  for (const rp of rackPages()) {
    const existing = rp.placements.find((pl) => pl.deviceNodeId === deviceId);
    if (existing) {
      throw new CommandError(
        `Device "${deviceId}" is already placed in a rack (placement "${existing.id}"). ` +
          `Remove it first with remove_device_from_rack.`,
      );
    }
  }

  const form = inferRackForm(data);
  if (form === "oversize") {
    throw new CommandError(`Device "${deviceId}" is too wide to mount in a 19" rack (oversize).`);
  }
  if (form === "shelf-only") {
    // Shelf-only gear (too small for a direct rack-mount panel) needs a shelf to sit on.
    // addPlacementSmart auto-creates a 1U shelf + the mounted placement atomically; we stamp
    // that shelf with provenance (markShelfCreatedByBridge) so remove_device_from_rack can
    // clean it up later WITHOUT risking a user-built or user-adopted shelf. addPlacementSmart
    // does no occupancy check, so pre-check the 1U the new shelf would claim.
    if (!st().isRackSlotAvailable(page.id, rackId, u.u, 1, f.face)) {
      throw new CommandError(`U${u.u} on the ${f.face} of rack "${rackId}" is occupied — no room for a shelf.`);
    }
    const res = st().addPlacementSmart(page.id, rackId, deviceId, u.u, f.face, undefined);
    if (!res.ok) {
      throw new CommandError(`Could not place device "${deviceId}" in rack "${rackId}" (${res.reason}).`);
    }
    return {
      placementId: res.placementId,
      shelfId: res.shelfId,
      rackId,
      deviceId,
      uPosition: u.u,
      face: f.face,
      form,
      // The device's physical height in U (consistent with list_racks). The auto-created shelf
      // itself claims a single U regardless of how tall the device standing on it is.
      heightU: inferRackHeightU(data),
    };
  }
  const heightU = inferRackHeightU(data);

  // addPlacementSmart does NOT check occupancy — it appends the placement unconditionally
  // (only its oversize/no-page/no-device early returns bail). So the bridge MUST pre-check
  // isRackSlotAvailable here, or two devices could be stacked into the same U range.
  let preferredHalfRackSide: "left" | "right" | undefined;
  if (form === "half") {
    // Pick the exact side that is free per the authoritative occupancy check, then pass
    // it to addPlacementSmart — its internal side heuristic is weaker (ignores multi-U
    // overlap, full-width blockers and accessories), so "either side free" alone is not
    // safe. isRackSlotAvailable(side)=true guarantees its sideTaken(side)=false, so the
    // side we pass is honored.
    const leftFree = st().isRackSlotAvailable(page.id, rackId, u.u, heightU, f.face, "left");
    const rightFree = st().isRackSlotAvailable(page.id, rackId, u.u, heightU, f.face, "right");
    preferredHalfRackSide = leftFree ? "left" : rightFree ? "right" : undefined;
    if (!preferredHalfRackSide) {
      throw new CommandError(`No free half-rack space at U${u.u} on the ${f.face} of rack "${rackId}".`);
    }
  } else {
    // full / unknown — full-width direct placement spanning heightU.
    if (!st().isRackSlotAvailable(page.id, rackId, u.u, heightU, f.face)) {
      throw new CommandError(`U${u.u}–${u.u + heightU - 1} on the ${f.face} of rack "${rackId}" is occupied or out of bounds.`);
    }
  }

  const res = st().addPlacementSmart(page.id, rackId, deviceId, u.u, f.face, preferredHalfRackSide);
  if (!res.ok) {
    throw new CommandError(`Could not place device "${deviceId}" in rack "${rackId}" (${res.reason}).`);
  }
  return {
    placementId: res.placementId,
    rackId,
    deviceId,
    uPosition: u.u,
    face: f.face,
    form,
    heightU,
    halfRackSide: preferredHalfRackSide,
  };
}

// ---------------------------------------------------------------------------
// Command handlers — each returns a JSON-serializable result or throws CommandError.
// ---------------------------------------------------------------------------
export const handlers: Record<CommandType, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  ...layoutHandlers,
  ...roomHandlers,
  capture_canvas: (params) => captureCanvas(params),
  search_jetbuilt_projects: async (params) => {
    return searchJetbuiltProjects(requiredText(params.query, "query"));
  },
  get_jetbuilt_project: async (params) => {
    const projectId = requiredText(params.projectId, "projectId");
    const extraction = await importDevicesFromJetbuiltProject(projectId);
    const previewId = crypto.randomUUID();
    jetbuiltPreviews.set(previewId, { projectId, extraction });
    if (jetbuiltPreviews.size > 3) jetbuiltPreviews.delete(jetbuiltPreviews.keys().next().value!);
    const items = extraction.results.map((item, index) => ({ ...item, itemId: `item-${index + 1}`, room: importRoomLabel(item.room) }));
    const roomNames = [...new Set([...items.map((item) => item.room), ...(extraction.bundleGroups ?? []).map((group) => importRoomLabel(group.room))])];
    return { previewId, projectId, name: extraction.fileName,
      rooms: roomNames.map((name) => ({ name, itemCount: items.filter((item) => item.room === name).length })),
      items, bundleGroups: extraction.bundleGroups ?? [], warnings: extraction.warnings,
      nextStep: "Choose rooms and kit before calling start_jetbuilt_schematic. This preview has not changed the canvas. Unresolved bundles need reviewed component definitions; never guess their contents." };
  },
  start_jetbuilt_schematic: async (params) => {
    const previewId = requiredText(params.previewId, "previewId");
    const preview = jetbuiltPreviews.get(previewId);
    if (!preview) throw new CommandError("Preview expired or belongs to another editor tab. Call get_jetbuilt_project again.");
    const rooms = selectedStrings(params.rooms, "rooms");
    const itemIds = selectedStrings(params.itemIds, "itemIds");
    for (const field of ["replaceCurrent", "expandQuantities", "includeUnmatched"]) {
      if (params[field] !== undefined && typeof params[field] !== "boolean") throw new CommandError(`${field} must be boolean.`);
    }
    const knownRooms = new Set([...preview.extraction.results.map((item) => importRoomLabel(item.room)), ...(preview.extraction.bundleGroups ?? []).map((group) => importRoomLabel(group.room))]);
    if (rooms?.some((room) => !knownRooms.has(room))) throw new CommandError("Unknown room. Use the exact room names from get_jetbuilt_project.");
    const allItems = preview.extraction.results.map((item, index) => ({ item, itemId: `item-${index + 1}` }));
    if (itemIds?.some((id) => !allItems.some((entry) => entry.itemId === id))) throw new CommandError("Unknown itemId. Use ids from this preview.");
    const selected = allItems.filter(({ item, itemId }) => (!rooms || rooms.includes(importRoomLabel(item.room))) && (!itemIds || itemIds.includes(itemId)));
    if (!selected.length) throw new CommandError("No kit items in this selection. Unresolved bundles must be reviewed in Start New Project first.");
    if (itemIds && selected.length !== new Set(itemIds).size) throw new CommandError("An itemId is outside the selected rooms.");
    const bundles = new Map((preview.extraction.bundleGroups ?? []).map((group) => [group.id, group]));
    if (selected.some(({ item }) => item.bundleGroupId && bundles.get(item.bundleGroupId)?.accepted !== true)) {
      throw new CommandError("Selected kit contains unreviewed bundle components. Review these in Start New Project, or select standalone/accepted items only.");
    }
    const before = st();
    if ((before.nodes.length || before.edges.length || before.pages.length) && params.replaceCurrent !== true) {
      throw new CommandError("The current schematic is not empty. Save it first; replaceCurrent=true is allowed only when the user explicitly asks to replace it.");
    }
    const templates = await allTemplates();
    const current = st();
    if (current.loadSeq !== before.loadSeq || current.nodes !== before.nodes || current.edges !== before.edges || current.pages !== before.pages
      || current.mcpBridgeEnabled !== before.mcpBridgeEnabled || current.mcpBridgeToken !== before.mcpBridgeToken
      || current.mcpBridgePort !== before.mcpBridgePort || current.mcpBridgeOffice !== before.mcpBridgeOffice || current.activePage !== before.activePage) {
      throw new CommandError("Editor session changed; retry the import.");
    }
    const byId = Object.fromEntries(templates.filter((template) => template.id).map((template) => [template.id!, template]));
    const items = selected.map(({ item }) => item);
    const notPlaced = selected.filter(({ item }) => !item.exactMatch || !byId[item.exactMatch.id])
      .map(({ item, itemId }) => ({ itemId, manufacturer: item.manufacturer, model: item.model, quantity: item.quantity, room: importRoomLabel(item.room), status: item.status }));
    const name = params.name !== undefined ? requiredText(params.name, "name")
      : `${preview.extraction.fileName}${rooms ? ` - ${rooms.join(", ")}` : ""}`;
    const file = buildQuoteImportSchematic(name, items, byId, { expandQuantities: params.expandQuantities !== false, includeUnmatched: params.includeUnmatched === true });
    st().newSchematic(file);
    st().setSchematicName(name);
    return { projectId: preview.projectId, ...(handlers.get_schematic({}) as object),
      notPlaced: params.includeUnmatched === true ? [] : notPlaced,
      unmatched: notPlaced, warnings: preview.extraction.warnings,
      unresolvedBundles: (preview.extraction.bundleGroups ?? []).filter((group) => !group.accepted && (!rooms || rooms.includes(importRoomLabel(group.room)))),
      nextStep: "Research unmatched Devices from official sources, then create_local_device and place_device_in_room. If placeholders were requested, replace them only after the researched Device is successfully placed. Read actual Ports before connecting." };
  },
  create_local_device: async (params) => {
    const validation = validateDeviceTemplate(params.template);
    if (!validation.ok) throw new CommandError(`Invalid local device: ${validation.errors.join("; ")}`);
    const template = normalizeDeviceTemplate(params.template);
    if (!template.label || !template.deviceType) throw new CommandError("label and deviceType must be non-empty.");
    const portIds = new Set<string>();
    for (const port of template.ports) {
      if (!port.id || portIds.has(port.id)) throw new CommandError("Every port needs a unique, non-empty id.");
      portIds.add(port.id);
      if (!Object.hasOwn(SIGNAL_LABELS, port.signalType) || !["input", "output", "bidirectional", "passthrough"].includes(port.direction)
        || (port.connectorType && !Object.hasOwn(CONNECTOR_LABELS, port.connectorType)))
        throw new CommandError(`Invalid signal, direction or connector for port "${port.id}". Call get_library_taxonomy.`);
    }
    const position = validatePosition((params.x ?? 0) as number, (params.y ?? 0) as number);
    if (!position.ok) throw new CommandError(position.error);
    if (params.placeOnCanvas !== undefined && typeof params.placeOnCanvas !== "boolean") throw new CommandError("placeOnCanvas must be boolean.");
    if (params.overrideExisting !== undefined && typeof params.overrideExisting !== "boolean") throw new CommandError("overrideExisting must be boolean.");
    const templates = await allTemplates();
    const identity = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const existing = params.overrideExisting === true ? undefined : [...st().customTemplates, ...templates].find((candidate) => template.manufacturer && template.modelNumber
      ? identity(candidate.manufacturer) === identity(template.manufacturer)
        && [candidate.modelNumber, ...(candidate.identityAliases ?? [])].some((value) => identity(value) === identity(template.modelNumber))
      : identity(candidate.label) === identity(template.label) && candidate.deviceType === template.deviceType);
    const deviceTemplate: DeviceTemplate = existing ?? { ...template, id: `local-ai-${crypto.randomUUID()}`, reviewStatus: "ai-researched", classificationConfidence: template.classificationConfidence ?? "low", version: undefined };
    if (!existing) st().addCustomTemplate(deviceTemplate);
    const placed = params.placeOnCanvas === false ? {} : addDeviceCore({templateId: deviceTemplate.id ?? deviceTemplate.deviceType, ...position.position}, [...templates, deviceTemplate]);
    const portDifferences = existing ? Array.from({ length: Math.max(template.ports.length, existing.ports.length) }, (_, index) => {
      const supplied = template.ports[index], reused = existing.ports[index];
      const fields = [...new Set([...Object.keys(supplied ?? {}), ...Object.keys(reused ?? {})])].filter(key => key !== "id") as (keyof Port)[];
      const changed = fields.filter(key => JSON.stringify(supplied?.[key]) !== JSON.stringify(reused?.[key]));
      return changed.length ? { index, fields: changed, supplied, reused } : undefined;
    }).filter(Boolean) : [];
    const instance = "nodeId" in placed ? requireDevice(placed.nodeId as string) : undefined;
    const instancePorts = (instance?.data as DeviceData | undefined)?.ports;
    const ignoredFields = existing ? (["label", "manufacturer", "modelNumber", "deviceType", "shortName"] as const).filter(key => template[key] !== undefined && template[key] !== existing[key]) : [];
    return { templateId: deviceTemplate.id ?? deviceTemplate.deviceType, scope: st().customTemplates.includes(deviceTemplate) ? "local" : "shared-existing",
      reused: !!existing, published: false, ...placed, portDifferences,
      ignoredFields,
      warnings: [...(portDifferences.length ? ["Existing template reused with different Ports. Use overrideExisting=true to preserve your corrected local definition."] : []), ...(ignoredFields.length ? [`Existing template reused; supplied fields ignored: ${ignoredFields.join(", ")}. Use overrideExisting=true to keep the supplied definition.`] : [])],
      ports: instancePorts,
      portIdMap: instancePorts ? Object.fromEntries(deviceTemplate.ports.map((port, i) => [port.id, instancePorts[i]?.id])) : undefined };
  },
  get_library_taxonomy: async () => ({ registry: await fetchTaxonomyRegistry(), connectors: CONNECTOR_LABELS, signals: SIGNAL_LABELS, directions: ["input", "output", "bidirectional", "passthrough"] }),
  propose_missing_device: (params) => proposeMissingDevice(params),
  get_device_proposal: async (params) => {
    if (typeof params.proposalId !== "string") throw new CommandError("proposalId is required.");
    const proposal = await getLibraryDoctorProposal(params.proposalId);
    const history = await getLibraryDoctorProposalHistory(params.proposalId);
    return { proposal, publishedTemplateId: history.find((event) => event.details.action === "published")?.details.templateId ?? null,
      nextStep: "A human must accept and then Publish approved device in Library Doctor before placement." };
  },
  add_approved_device: async (params) => {
    const loadSeq = st().loadSeq;
    const enabled = st().mcpBridgeEnabled;
    const token = st().mcpBridgeToken;
    const port = st().mcpBridgePort;
    const office = st().mcpBridgeOffice;
    const page = st().activePage;
    const result = await handlers.get_device_proposal(params) as {proposal: {status: string; proposalType: string}; publishedTemplateId: unknown};
    if (result.proposal.status !== "accepted" || result.proposal.proposalType !== "new-template" || typeof result.publishedTemplateId !== "string")
      throw new CommandError("This device has not been approved and published by a human in Library Doctor.");
    await refreshTemplates();
    const templates = await allTemplates();
    if (st().loadSeq !== loadSeq || st().mcpBridgeEnabled !== enabled || st().mcpBridgeToken !== token || st().mcpBridgePort !== port || st().mcpBridgeOffice !== office || st().activePage !== page) throw new CommandError("Editor session changed; retry the command.");
    return addDeviceCore({ ...params, templateId: result.publishedTemplateId } as unknown as AddDeviceParams, templates);
  },
  get_schematic: () => {
    const devices = deviceNodes().map((n) => {
      const d = n.data as DeviceData;
      return {
        nodeId: n.id,
        label: d.label,
        deviceType: d.deviceType,
        manufacturer: d.manufacturer,
        displayHeader: resolveDeviceHeader(d, st()).displayHeader.map((line, index) => index === 0 ? transformLabelNow(line) : line),
        position: n.position,
        parentId: n.parentId,
        ...deviceGeometry(n),
        slotCount: (d.slots ?? []).length,
        ports: (d.ports ?? []).map(portSummary),
      };
    });
    const connections = st().edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      ...e.data,
    }));
    const rooms = st().nodes.filter((n) => n.type === "room").map(roomSummary);
    const notes = st().nodes.filter((n) => n.type === "note").map(noteSummary);
    return {
      schematicName: st().schematicName,
      deviceCount: devices.length,
      connectionCount: connections.length,
      roomCount: rooms.length,
      noteCount: notes.length,
      devices,
      connections,
      rooms,
      notes,
      stubs: st().nodes.filter(n => n.type === "stub-label").map(n => ({ stubId: n.id, position: n.position, parentId: n.parentId, ...n.data })),
      sheet: sheetSummary(),
    };
  },

  list_devices: () =>
    deviceNodes().map((n) => {
      const d = n.data as DeviceData;
      return {
        nodeId: n.id,
        label: d.label,
        deviceType: d.deviceType,
        manufacturer: d.manufacturer,
        displayHeader: resolveDeviceHeader(d, st()).displayHeader.map((line, index) => index === 0 ? transformLabelNow(line) : line),
        modelNumber: d.modelNumber,
        position: n.position,
        parentId: n.parentId,
      };
    }),

  get_device: (params) => {
    const { nodeId } = params as unknown as GetDeviceParams;
    const node = requireDevice(nodeId);
    const d = node.data as DeviceData;
    return {
      nodeId: node.id,
      label: d.label,
      shortName: d.shortName,
      displayHeader: resolveDeviceHeader(d, st()).displayHeader.map((line, index) => index === 0 ? transformLabelNow(line) : line),
      headerLine2: d.headerLine2, showManufacturerModel: d.showManufacturerModel, showDeviceType: d.showDeviceType,
      deviceType: d.deviceType,
      manufacturer: d.manufacturer,
      modelNumber: d.modelNumber,
      position: node.position,
      parentId: node.parentId,
      ...deviceGeometry(node),
      ports: (d.ports ?? []).map(portSummary),
      slots: (d.slots ?? []).map(slotSummary),
    };
  },

  search_templates: async (params) => {
    const { query, limit } = params as unknown as SearchTemplatesParams;
    const q = (query ?? "").trim().toLowerCase();
    const list = await allTemplates();
    const scored = list.filter((t) => {
      if (!q) return true;
      const hay = [t.label, t.deviceType, t.manufacturer, t.modelNumber, ...(t.searchTerms ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    return scored.slice(0, Math.max(1, Math.min(limit ?? 25, 100))).map((t) => ({
      templateId: t.id ?? t.deviceType,
      label: t.label,
      deviceType: t.deviceType,
      manufacturer: t.manufacturer,
      portCount: (t.ports ?? []).length,
    }));
  },

  add_device: async (params) => {
    return addDeviceCore(params as unknown as AddDeviceParams, await allTemplates());
  },

  set_device_property: (params) => {
    const { nodeId, properties } = params as unknown as SetDevicePropertyParams;
    requireDevice(nodeId);
    if (!properties || typeof properties !== "object") {
      throw new CommandError("properties must be an object.");
    }
    const { label, shortName, patch, applied, rejected } = classifyDeviceProperties(properties);
    if (applied.length === 0) {
      throw new CommandError(
        `No editable fields. Rejected (not allowed in Beta): ${rejected.join(", ")}.`,
      );
    }
    if (label !== undefined) st().updateDeviceLabel(nodeId, label);
    if (shortName !== undefined) st().updateDeviceShortName(nodeId, shortName);
    if (Object.keys(patch).length > 0) st().patchDeviceData(nodeId, patch as Partial<DeviceData>);
    return { nodeId, applied, rejected };
  },

  connect_devices: (params) => connectDevicesCore(params as unknown as ConnectDevicesParams),

  delete_device: (params) => {
    const { nodeId } = params as unknown as DeleteDeviceParams;
    requireDevice(nodeId);
    st().deleteNode(nodeId);
    return { deleted: true, nodeId };
  },

  move_device: (params) => {
    const { nodeId, x, y } = params as unknown as MoveDeviceParams;
    const node = requireDevice(nodeId);
    const pos = validatePosition(x, y);
    if (!pos.ok) throw new CommandError(pos.error);
    const rect = absRect(node, new Map(st().nodes.map(n => [n.id, n])));
    const absolute = { x: pos.position.x + rect.left - node.position.x, y: pos.position.y + rect.top - node.position.y };
    st().moveDevice(nodeId, absolute);
    const moved = requireDevice(nodeId);
    return { nodeId, position: moved.position, parentId: moved.parentId, ...deviceGeometry(moved) };
  },

  delete_connection: (params) => {
    const { connectionId } = params as unknown as DeleteConnectionParams;
    if (!connectionId) throw new CommandError("connectionId is required.");
    const plan = planConnectionRemoval(st().edges, connectionId);
    if (!plan.ok) throw new CommandError(plan.error);
    const { removedStubLinks } = st().deleteConnection(plan.removeId);
    // Deleting one half of a stubbed connection takes the other half and both stub
    // labels with it (#318) — say so, rather than reporting only the requested id back.
    return removedStubLinks > 0
      ? { deleted: true, connectionId, cascadedStubConnection: true }
      : { deleted: true, connectionId };
  },

  add_devices: async (params) => {
    const { devices } = (params ?? {}) as unknown as AddDevicesParams;
    // One template fetch for the whole batch (allTemplates() is cached anyway).
    const templates = await allTemplates();
    const outcome = runBatch(devices, MAX_BATCH_ITEMS, (spec: AddDeviceParams) =>
      addDeviceCore(spec, templates),
    );
    if (!outcome.ok) throw new CommandError(outcome.error);
    return { results: outcome.results, succeeded: outcome.succeeded, failed: outcome.failed };
  },

  connect_devices_batch: (params) => {
    const { connections } = (params ?? {}) as unknown as ConnectDevicesBatchParams;
    const outcome = runBatch(connections, MAX_BATCH_ITEMS, (c: ConnectDevicesParams) =>
      connectDevicesCore(c),
    );
    if (!outcome.ok) throw new CommandError(outcome.error);
    return { results: outcome.results, succeeded: outcome.succeeded, failed: outcome.failed };
  },

  create_room: (params) => {
    const { label, x, y, width, height } = params as unknown as CreateRoomParams;
    if (typeof label !== "string" || label.trim() === "") {
      throw new CommandError("label is required (a non-empty room name).");
    }
    const pos = validatePosition(x, y);
    if (!pos.ok) throw new CommandError(pos.error);
    const size = validateRoomSize(width, height);
    if (!size.ok) throw new CommandError(size.error);
    const beforeRooms = new Set(st().nodes.filter((n) => n.type === "room").map((n) => n.id));
    const beforeParents = new Map(deviceNodes().map((n) => [n.id, n.parentId] as const));
    st().addRoom(label, pos.position, size.size);
    const room = st().nodes.find((n) => n.type === "room" && !beforeRooms.has(n.id));
    if (!room) throw new CommandError("Room was not created (no new room node appeared).");
    // addRoom runs reparentAllDevices, which pulls any existing devices that now fall
    // inside the new room into it (and rewrites their coords to room-relative). Report
    // those so the caller knows those devices' positions changed (re-read via get_device
    // / get_schematic before using their old coordinates).
    const absorbedDeviceIds = deviceNodes()
      .filter((n) => n.parentId === room.id && beforeParents.get(n.id) !== room.id)
      .map((n) => n.id);
    return {
      roomId: room.id,
      label: (room.data as { label?: string }).label ?? label,
      position: pos.position,
      size: { width: size.size?.width ?? 400, height: size.size?.height ?? 300 },
      absorbedDeviceIds,
    };
  },

  place_device_in_room: (params) => {
    const { deviceId, roomId, x, y } = params as unknown as PlaceDeviceInRoomParams;
    requireDevice(deviceId);
    const room = st().nodes.find((n) => n.id === roomId);
    if (!room) throw new CommandError(`No room found with id "${roomId}".`);
    if (room.type !== "room") throw new CommandError(`Node "${roomId}" is not a room.`);
    let rel = { x: 16, y: 16 };
    if (x !== undefined || y !== undefined) {
      const pos = validatePosition(x, y);
      if (!pos.ok) throw new CommandError(pos.error);
      rel = pos.position;
    }
    // The store action is atomic and returns whether it actually committed: it mutates
    // only if the device's center lands inside the requested room, otherwise it changes
    // nothing. Gate on that boolean (NOT a parentId read-back, which can't tell a
    // rejected placement of an already-in-this-room device from a real one).
    const placed = st().placeDeviceInRoom(deviceId, roomId, rel);
    if (!placed || requireDevice(deviceId).parentId !== roomId) {
      const after = st().nodes.find((n) => n.id === deviceId);
      throw new CommandError(
        `Device "${deviceId}" could not be placed in room "${roomId}": at the given position ` +
          `(${rel.x}, ${rel.y} relative to the room) its center falls outside the room or inside a ` +
          `nested room (current parent: ${after?.parentId ?? "none"}). Adjust x/y or enlarge the room.`,
      );
    }
    return { nodeId: deviceId, roomId, position: rel };
  },

  add_note: (params) => {
    const { text, x, y } = params as unknown as AddNoteParams;
    if (typeof text !== "string" || text.trim() === "") {
      throw new CommandError("text is required (a non-empty note).");
    }
    const pos = validatePosition(x, y);
    if (!pos.ok) throw new CommandError(pos.error);
    const size = noteSize(params, text);
    // No store action returns the new note's id, and addNote/updateNoteHtml are two
    // calls — but only addNote pushes undo, so the pair is a single undo step. Snapshot
    // ids, create the (empty) note, then set its escaped HTML on the new node.
    const before = new Set(st().nodes.map((n) => n.id));
    st().addNote(pos.position);
    const note = st().nodes.find((n) => n.type === "note" && !before.has(n.id));
    if (!note) throw new CommandError("Note was not created (no new note node appeared).");
    st().updateNoteHtml(note.id, noteTextToHtml(text));
    st().patchContainerNode(note.id, size, { skipUndo: true });
    return { noteId: note.id, text, position: pos.position, ...size };
  },

  list_slot_cards: (params) => {
    const { deviceId, slotId } = params as unknown as ListSlotCardsParams;
    const device = requireDevice(deviceId);
    const slot = requireSlot(device, slotId);
    if (!slot.slotFamily) return { slotId, slotFamily: undefined, cards: [] };
    // Reads the current library view (live-library cache if warmed by an earlier
    // search_templates call, plus the bundled floor) and this schematic's custom
    // templates — the same view install_card resolves against. Only cards with a real
    // template id are returned: install_card resolves by id, so an id-less card could
    // be listed but not installed (kept consistent here).
    // Known minor limitation: if a custom template reuses a library card's id,
    // install_card's getTemplateById prefers the library copy, so the listed-vs-
    // installed card could differ. This can't corrupt state — install_card re-checks
    // the slot family and re-reads the slot, so a wrong-family resolution just rejects.
    const cards = getCardsByFamily(slot.slotFamily, st().customTemplates)
      .filter((t) => Boolean(t.id))
      .map((t) => ({
        templateId: t.id!,
        label: t.label,
        manufacturer: t.manufacturer,
        modelNumber: t.modelNumber,
      }));
    return { slotId, slotFamily: slot.slotFamily, cards };
  },

  install_card: (params) => installCardCore((params ?? {}) as unknown as InstallCardParams),

  install_card_batch: (params) => {
    const { installs } = (params ?? {}) as unknown as InstallCardBatchParams;
    const outcome = runBatch(installs, MAX_BATCH_ITEMS, (p: InstallCardParams) => installCardCore(p));
    if (!outcome.ok) throw new CommandError(outcome.error);
    return { results: outcome.results, succeeded: outcome.succeeded, failed: outcome.failed };
  },

  remove_card: (params) => {
    const { deviceId, slotId } = params as unknown as RemoveCardParams;
    const device = requireDevice(deviceId);
    const slot = requireSlot(device, slotId);
    // Empty slot -> nothing to remove. Reject WITHOUT calling swapCard, which would
    // push an empty undo step and rebuild the (already-empty) slot for no reason.
    if (!slot.cardTemplateId) {
      throw new CommandError(`Slot "${slotId}" is already empty.`);
    }
    st().swapCard(deviceId, slotId, null);
    const after = requireSlot(requireDevice(deviceId), slotId);
    if (after.cardTemplateId) {
      throw new CommandError(`Card could not be removed from slot "${slotId}".`);
    }
    return { deviceId, slotId, emptied: true };
  },

  list_racks: () => {
    const pages = rackPages().map((page) => ({
      pageId: page.id,
      label: page.label,
      racks: page.racks.map((r) => ({
        rackId: r.id,
        label: r.label,
        rackType: r.rackType,
        heightU: r.heightU,
        depthMm: r.depthMm,
        widthClass: r.widthClass,
        placements: page.placements.filter((pl) => pl.rackId === r.id).map(rackPlacementSummary),
        // Accessories (shelves, blank/vent panels, etc.) also occupy U positions, so list
        // them too — otherwise a U that's blocked by, say, a shelf would look free here and
        // place_device_in_rack would reject it for no visible reason.
        accessories: page.accessories
          .filter((a) => a.rackId === r.id)
          // createdByBridge: this shelf was auto-created by the bridge and not yet adopted by
          // the user, so remove_device_from_rack will clean it up with its device.
          .map((a) => ({ accessoryId: a.id, type: a.type, label: a.label, uPosition: a.uPosition, heightU: a.heightU, createdByBridge: false })),
      })),
    }));
    return { pageCount: pages.length, pages };
  },

  create_rack: (params) => {
    const { label, heightU, rackType, depthMm, pageId, pageLabel } = params as unknown as CreateRackParams;
    const spec = validateRackSpec(rackType, heightU, depthMm);
    if (!spec.ok) throw new CommandError(spec.error);
    const rackLabel = typeof label === "string" && label.trim() !== "" ? label.trim() : "Rack";

    // Resolve the target page. An explicit pageId must already exist; otherwise create a
    // fresh rack page. (Creating a page here is a second undo step — addRackPage and
    // addRack each push undo — but that only happens on the first rack; coalescing would
    // need a store change, out of scope.)
    let targetPageId: string;
    let createdPage = false;
    if (pageId !== undefined) {
      // Fail on zero or multiple matches rather than guessing — addRack applies through
      // mapElevationPage, which would write to EVERY page sharing this id (same fail-on-
      // ambiguity rule as requireRack / requirePlacement).
      const matches = rackPages().filter((p) => p.id === pageId);
      if (matches.length === 0) {
        throw new CommandError(`No rack-elevation page found with id "${pageId}". Call list_racks, or omit pageId to create one.`);
      }
      if (matches.length > 1) {
        throw new CommandError(`Page id "${pageId}" is ambiguous (matches ${matches.length} pages).`);
      }
      targetPageId = pageId;
    } else {
      const newLabel = typeof pageLabel === "string" && pageLabel.trim() !== "" ? pageLabel.trim() : "Rack Elevation";
      targetPageId = st().addRackPage(newLabel);
      createdPage = true;
    }

    // New rack x-position follows the editor: PAGE-LOCAL rack count * 400 (a new page
    // starts at 0).
    const page = rackPages().find((p) => p.id === targetPageId)!;
    const position = { x: page.racks.length * 400, y: 0 };

    const rackId = st().addRack(targetPageId, {
      label: rackLabel,
      rackType: spec.rackType,
      heightU: spec.heightU,
      depthMm: spec.depthMm,
      widthClass: "19in",
      position,
    });
    return {
      pageId: targetPageId,
      rackId,
      label: rackLabel,
      rackType: spec.rackType,
      heightU: spec.heightU,
      depthMm: spec.depthMm,
      createdPage,
    };
  },

  place_device_in_rack: (params) => placeDeviceInRackCore((params ?? {}) as unknown as PlaceDeviceInRackParams),

  place_device_in_rack_batch: (params) => {
    const { placements } = (params ?? {}) as unknown as PlaceDeviceInRackBatchParams;
    const outcome = runBatch(placements, MAX_BATCH_ITEMS, (p: PlaceDeviceInRackParams) => placeDeviceInRackCore(p));
    if (!outcome.ok) throw new CommandError(outcome.error);
    return { results: outcome.results, succeeded: outcome.succeeded, failed: outcome.failed };
  },

  remove_device_from_rack: (params) => {
    const { placementId } = params as unknown as RemoveDeviceFromRackParams;
    if (!placementId) throw new CommandError("placementId is required.");
    const { page } = requirePlacement(placementId);
    // If this device sits on a shelf the bridge auto-created FOR THIS placement, and the user
    // hasn't adopted that shelf, clean it up along with the device (one undo step). The shelf
    // is removed ONLY when ALL hold: the placement is shelf-mounted; the shelf still exists;
    // its provenance is still bound to THIS exact placement (any user edit / second occupant /
    // page-duplication clears the binding); and this placement is the shelf's sole occupant.
    // Anything else → remove just the placement, never touching a user/adopted shelf.
    // Remove only the placement (one undo step). The device stays on the schematic.
    st().removeRackPlacement(page.id, placementId);
    return { removed: true, placementId };
  },

  update_note: (params) => {
    const { noteId, text } = params as unknown as UpdateNoteParams;
    const note = requireNote(noteId);
    if (text !== undefined && (typeof text !== "string" || text.trim() === "")) {
      throw new CommandError("text is required (a non-empty note).");
    }
    const size = noteSize(params, text ?? noteHtmlToText((note.data as { html: string }).html), note);
    const html = text === undefined ? (note.data as { html: string }).html : noteTextToHtml(text);
    const current = (requireNote(noteId).data as { html?: string }).html ?? "";
    // No-op when the content is unchanged — updateNoteHtml does not guard identical writes,
    // and pushSnapshot() would otherwise add an empty undo step (the editor's own commit
    // path is likewise gated on `html !== data.html`).
    if (html === current && size.width === (note.measured?.width ?? note.width ?? note.style?.width ?? 200) && size.height === (note.measured?.height ?? note.height ?? note.style?.height ?? 100)) {
      return { noteId, text, changed: false };
    }
    // pushSnapshot() makes this a single undo step (updateNoteHtml itself does not push undo,
    // because the editor calls it on every keystroke and snapshots separately). Text is
    // XSS-safe via the same noteTextToHtml path add_note uses.
    st().patchContainerNode(noteId, { html, ...size });
    return { noteId, text, ...size, changed: true };
  },

  delete_note: (params) => {
    const { noteId } = params as unknown as DeleteNoteParams;
    requireNote(noteId);
    // deleteNode selects only this note and routes through removeSelected (undoable, full
    // cleanup). Notes have no ports/edges/children, so nothing cascades. delete_device uses
    // the same path.
    st().deleteNode(noteId);
    return { deleted: true, noteId };
  },
};

// ---------------------------------------------------------------------------
// Connection controller — a singleton driven by the useMcpBridge() hook.
// ---------------------------------------------------------------------------
class BridgeController {
  private ws: WebSocket | null = null;
  private enabled = false;
  private token = "";
  private port = DEFAULT_BRIDGE_PORT;
  private office = false;
  private clientId =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}`;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  /** Set when pairing was refused (bad token / superseded) so we stop retrying. */
  private halted = false;

  /** (Re)start with the latest settings. Idempotent for unchanged inputs. */
  start(token: string, port: number, office = false) {
    if (this.enabled && this.token === token && this.port === port && this.office === office && (this.ws || this.reconnectTimer)) {
      return; // already running with the same config (StrictMode-safe)
    }
    this.stop();
    this.enabled = true;
    this.token = token;
    this.port = port || DEFAULT_BRIDGE_PORT;
    this.office = office;
    this.halted = false;
    this.backoffMs = 1000;
    this.connect();
  }

  stop() {
    this.enabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    setStatus("off");
  }

  private scheduleReconnect() {
    if (!this.enabled || this.halted) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 15000);
  }

  private connect() {
    if (!this.enabled || this.halted) return;
    setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.office ? "wss://schematic-mcp.tateside.online/editor" : `ws://127.0.0.1:${this.port}`);
    } catch {
      setStatus("error", "Could not open a connection.");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          protocolVersion: PROTOCOL_VERSION,
          clientId: this.clientId,
          schematicName: st().schematicName,
        }),
      );
    };

    ws.onmessage = (ev) => this.onMessage(ev, ws);

    ws.onerror = () => {
      setStatus("error", "Connection error — is the MCP server running?");
    };

    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      if (this.office && event.code === 1008) {
        this.halted = true;
        setStatus("error", "Office sign-in expired. Reconnect your office account in Preferences.");
      }
      if (this.enabled && !this.halted) {
        setStatus("connecting", "Reconnecting…");
        this.scheduleReconnect();
      }
    };
  }

  private async onMessage(ev: MessageEvent, socket: WebSocket) {
    if (socket !== this.ws) return;
    let msg: BridgeServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.type === "hello_ack") {
      if (msg.ok) {
        this.backoffMs = 1000;
        setStatus("connected");
      } else {
        this.halted = true;
        setStatus("error", msg.reason ?? "Pairing refused.");
      }
      return;
    }
    if (msg.type === "superseded") {
      this.halted = true;
      setStatus("error", msg.reason ?? "Another tab took the AI connection.");
      return;
    }
    if (msg.type === "command") {
      const { requestId, command, params } = msg;
      const reply = (ok: boolean, payload: { result?: unknown; error?: string }) => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", requestId, ok, ...payload }));
      };
      const handler = handlers[command];
      if (!handler) {
        reply(false, { error: `Unknown command "${command}".` });
        return;
      }
      try {
        const result = await handler(params ?? {});
        reply(true, { result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply(false, { error: message });
      }
    }
  }
}

export const mcpBridge = new BridgeController();

/** Mount once (in App). Starts/stops the bridge as the Beta setting changes. */
export function useMcpBridge() {
  const enabled = useSchematicStore((s) => s.mcpBridgeEnabled);
  const token = useSchematicStore((s) => s.mcpBridgeToken);
  const port = useSchematicStore((s) => s.mcpBridgePort);
  const office = useSchematicStore((s) => s.mcpBridgeOffice);
  useEffect(() => {
    if (enabled && (token || office)) mcpBridge.start(office ? "office-access" : token, port, office);
    else mcpBridge.stop();
    return () => mcpBridge.stop();
  }, [enabled, token, port, office]);
}
