import { CURRENT_SCHEMA_VERSION } from "../migrations";
import type { DeviceNode, DeviceTemplate, SchematicFile, SchematicNode } from "../types";
import type { QuoteImportResultItem } from "../quoteImportTypes";

const DEVICE_WIDTH = 260;
const DEVICE_HEIGHT = 120;
const ROOM_PAD = 60;
const ROOM_GAP = 40;
const DEVICE_GAP = 30;

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function copyTemplatePorts(template: DeviceTemplate, seed: string) {
  return template.ports.map((port, index) => ({ ...port, id: `${seed}-p${index + 1}` }));
}

function makeDeviceNode(item: QuoteImportResultItem, index: number, template?: DeviceTemplate): DeviceNode {
  const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
  const baseLabel = [item.manufacturer, item.model].filter(Boolean).join(" ") || item.model;
  const label = quantity > 1 ? `${baseLabel} x${quantity}` : baseLabel;
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
): SchematicFile {
  const nodes: SchematicNode[] = [];
  const byRoom = new Map<string, QuoteImportResultItem[]>();

  for (const item of items) {
    const room = clean(item.room) || "Imported Devices";
    byRoom.set(room, [...(byRoom.get(room) ?? []), item]);
  }

  let y = 40;
  let deviceIndex = 0;
  [...byRoom.entries()].forEach(([room, roomItems], roomIndex) => {
    const roomId = `quote-room-${roomIndex + 1}`;
    const height = ROOM_PAD * 2 + roomItems.length * DEVICE_HEIGHT + Math.max(0, roomItems.length - 1) * DEVICE_GAP;
    nodes.push({
      id: roomId,
      type: "room",
      position: { x: 40, y },
      data: { label: room },
      style: { width: DEVICE_WIDTH + ROOM_PAD * 2, height },
      zIndex: -1,
    } as SchematicNode);

    roomItems.forEach((item, localIndex) => {
      const template = item.exactMatch?.id ? libraryTemplatesById[item.exactMatch.id] : undefined;
      const node = makeDeviceNode(item, deviceIndex++, template);
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
