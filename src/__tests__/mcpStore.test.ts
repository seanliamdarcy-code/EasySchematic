import { describe, it, expect, beforeEach } from "vitest";
import { useSchematicStore } from "../store";
import type { DeviceData, SchematicNode, ConnectionEdge } from "../types";
const device = (id: string, x: number, selected = false): SchematicNode => ({id, type:"device", position:{x,y:20}, selected, data:{label:id,deviceType:"camera",ports:[]} as DeviceData});
beforeEach(() => useSchematicStore.setState({nodes:[device("one",20,true),device("two",300)],edges:[{id:"link",source:"one",target:"two",data:{signalType:"hdmi"}} as ConnectionEdge]}));
describe("MCP store integration", () => {
  it("moving is undoable and leaves unrelated devices intact", () => {
    useSchematicStore.getState().moveDevice("one",{x:100,y:100});
    expect(useSchematicStore.getState().nodes[0].position).toEqual({x:100,y:100});
    expect(useSchematicStore.getState().nodes[1].position).toEqual({x:300,y:20});
    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().nodes[0].position).toEqual({x:20,y:20});
  });
  it("connection deletion preserves selected devices and can be undone", () => {
    useSchematicStore.getState().deleteConnection("link");
    expect(useSchematicStore.getState().nodes).toHaveLength(2);
    expect(useSchematicStore.getState().nodes[0].selected).toBe(true);
    expect(useSchematicStore.getState().edges).toHaveLength(0);
    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().edges).toHaveLength(1);
  });
  it("invalid room placement leaves the document untouched", () => {
    useSchematicStore.getState().addRoom("Meeting",{x:0,y:0},{width:800,height:600});
    const room=useSchematicStore.getState().nodes.find(n=>n.type==="room")!;
    const before=JSON.stringify(useSchematicStore.getState().nodes);
    expect(useSchematicStore.getState().placeDeviceInRoom("one",room.id,{x:2000,y:2000})).toBe(false);
    expect(JSON.stringify(useSchematicStore.getState().nodes)).toBe(before);
    expect(useSchematicStore.getState().placeDeviceInRoom("one",room.id,{x:30,y:30})).toBe(true);
    expect(useSchematicStore.getState().nodes.find(n=>n.id==="one")?.parentId).toBe(room.id);
  });
});
