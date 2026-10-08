import { useSchematicStore } from "../store";
import { absRect } from "../snapUtils";
import { validatePosition, validateRoomSize } from "./validation";
import type { RoomData } from "../types";

const state = () => useSchematicStore.getState();
function room(id: unknown) {
  const n = state().nodes.find(n => n.id === id && n.type === "room");
  if (!n) throw new Error("Room not found.");
  if ((n.data as RoomData).locked) throw new Error("Unlock the room before editing or deleting it.");
  return n;
}
export const roomHandlers = {
  update_room: (p: Record<string, unknown>) => {
    const n = room(p.roomId);
    if (p.label !== undefined && (typeof p.label !== "string" || !p.label.trim() || p.label.length > 2000)) throw new Error("label must be non-empty text up to 2000 characters.");
    if (p.fitToChildren !== undefined && typeof p.fitToChildren !== "boolean") throw new Error("fitToChildren must be boolean.");
    if (p.padding !== undefined && (typeof p.padding !== "number" || !Number.isFinite(p.padding) || p.padding < 16 || p.padding > 1000)) throw new Error("padding must be between 16 and 1000.");
    if (p.fitToChildren && [p.x, p.y, p.width, p.height].some(v => v !== undefined)) throw new Error("Use fitToChildren separately from explicit position/size.");
    let position = n.position;
    let width = n.measured?.width ?? n.width ?? (n.style?.width as number | undefined) ?? 400;
    let height = n.measured?.height ?? n.height ?? (n.style?.height as number | undefined) ?? 300;
    if (p.x !== undefined || p.y !== undefined) {
      const pos = validatePosition(p.x as number, p.y as number);
      if (!pos.ok) throw new Error(pos.error);
      // MCP room movement is absolute, even for nested rooms.
      const rect = absRect(n, new Map(state().nodes.map(n => [n.id, n])));
      position = { x: pos.position.x - rect.left + n.position.x, y: pos.position.y - rect.top + n.position.y };
    }
    if (p.width !== undefined || p.height !== undefined) {
      const size = validateRoomSize(p.width ?? width, p.height ?? height);
      if (!size.ok) throw new Error(size.error);
      width = size.size!.width; height = size.size!.height;
    }
    if (p.fitToChildren) {
      const children = state().nodes.filter(child => child.parentId === n.id);
      if (!children.length) throw new Error("Room has no children to fit.");
      const map = new Map(state().nodes.map(n => [n.id, n]));
      const rects = children.map(c => absRect(c, map));
      const padding = (p.padding as number | undefined) ?? 32;
      const left = Math.min(...rects.map(r => r.left)) - padding;
      const top = Math.min(...rects.map(r => r.top)) - padding - 24;
      const old = absRect(n, map);
      position = { x: n.position.x + left - old.left, y: n.position.y + top - old.top };
      width = Math.max(200, Math.max(...rects.map(r => r.right)) - left + padding);
      height = Math.max(150, Math.max(...rects.map(r => r.bottom)) - top + padding);
    }
    state().patchContainerNode(n.id, { position, width, height, label: p.label as string | undefined }, { preserveChildren: p.fitToChildren === true });
    const updated = state().nodes.find(c => c.id === n.id)!;
    const rect = absRect(updated, new Map(state().nodes.map(n => [n.id, n])));
    return { roomId: n.id, label: updated.data.label, position: updated.position, absoluteBounds: { x: rect.left, y: rect.top, w: width, h: height },
      childIds: state().nodes.filter(c => c.parentId === n.id).map(c => c.id) };
  },
  delete_room: (p: Record<string, unknown>) => {
    const n = room(p.roomId);
    const childIds = state().nodes.filter(c => c.parentId === n.id).map(c => c.id);
    state().deleteNode(n.id);
    return { deleted: true, roomId: n.id, unparentedChildIds: childIds };
  },
};
