import { CURRENT_SCHEMA_VERSION } from "../migrations";
import type { DeviceNode, DeviceTemplate, SchematicFile, SchematicNode } from "../types";
import type { QuoteImportResultItem } from "../quoteImportTypes";

const DEVICE_WIDTH = 260;
const DEVICE_HEIGHT = 120;
const ROOM_PAD = 60;
const ROOM_GAP = 40;
const DEVICE_GAP = 30;

export function importRoomLabel(room: string | null | undefined): string {
  return room?.trim() || "Unassigned";
}

function copyTemplatePorts(template: DeviceTemplate, seed: string) {
  return template.ports.map((port, index) => ({ ...port, id: `${seed}-p${index + 1}` }));
}

function makeDeviceNode(item: QuoteImportResultItem, index: number, template?: DeviceTemplate, instance?: number): DeviceNode {
  const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
  const baseLabel = [item.manufacturer, item.model].filter(Boolean).join(" ") || item.model;
  const label = quantity > 1 ? instance === undefined ? `${baseLabel} x${quantity}` : `${baseLabel} ${instance + 1}` : baseLabel;
  const nodeId = `quote-device-${index + 1}`;

  return {
    id: nodeId,
    type: "device",
    position: { x: ROOM_PAD, y: ROOM_PAD + index * (DEVICE_HEIGHT + DEVICE_GAP) },
    data: {
      label,
      shortName: item.model,
      deviceType: template?.deviceType ?? "converter",
      ports: template ? copyTemplatePorts(template, nodeId) : [],
      ...(template?.color ? { color: template.color } : {}),
      manufacturer: item.manufacturer ?? template?.manufacturer,
      modelNumber: item.model,
      baseLabel: label,
      model: item.model,
      ...(template?.id ? { templateId: template.id } : {}),
      ...(template?.version ? { templateVersion: template.version } : {}),
    },
  };
}

export function buildQuoteImportSchematic(
  name: string,
  items: QuoteImportResultItem[],
  libraryTemplatesById: Record<string, DeviceTemplate>,
  options: { expandQuantities?: boolean; includeUnmatched?: boolean } = {},
): SchematicFile {
  const nodes: SchematicNode[] = [];
  const byRoom = new Map<string, QuoteImportResultItem[]>();

  for (const item of items) {
    const room = importRoomLabel(item.room);
    byRoom.set(room, [...(byRoom.get(room) ?? []), item]);
  }

  let y = 40;
  let deviceIndex = 0;
  const count = items.reduce((total, item) => total + (options.expandQuantities ? Math.max(1, Math.round(Number(item.quantity) || 1)) : 1), 0);
  if (!Number.isFinite(count) || count > 1000) throw new Error("Import is limited to 1000 Devices. Select fewer rooms or kit items.");
  [...byRoom.entries()].forEach(([room, roomItems], roomIndex) => {
    const instances = roomItems.flatMap((item) => {
      const template = item.exactMatch?.id ? libraryTemplatesById[item.exactMatch.id] : undefined;
      if (options.includeUnmatched === false && !template) return [];
      const quantity = options.expandQuantities ? Math.max(1, Math.round(Number(item.quantity) || 1)) : 1;
      return Array.from({ length: quantity }, (_, instance) => ({ item, template, instance }));
    });
    const roomId = `quote-room-${roomIndex + 1}`;
    const height = ROOM_PAD * 2 + Math.max(1, instances.length) * DEVICE_HEIGHT + Math.max(0, instances.length - 1) * DEVICE_GAP;
    nodes.push({
      id: roomId,
      type: "room",
      position: { x: 40, y },
      data: { label: room },
      style: { width: DEVICE_WIDTH + ROOM_PAD * 2, height },
      zIndex: -1,
    } as SchematicNode);

    instances.forEach(({ item, template, instance }, localIndex) => {
      const node = makeDeviceNode(item, deviceIndex++, template, options.expandQuantities ? instance : undefined);
      node.parentId = roomId;
      node.position = { x: ROOM_PAD, y: ROOM_PAD + localIndex * (DEVICE_HEIGHT + DEVICE_GAP) };
      nodes.push(node);
    });

    y += height + ROOM_GAP;
  });

  return {
    version: CURRENT_SCHEMA_VERSION,
    name,
    nodes,
    edges: [],
  };
}
