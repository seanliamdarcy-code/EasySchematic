import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

test("initialization signals a refreshed tool catalog with room and sheet controls", async () => {
  const server = createMcpServer(async () => ({}));
  const client = new Client({ name: "catalog-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let changed = false;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed = true; });
  try {
    await server.connect(a); await client.connect(b);
    const { tools } = await client.listTools();
    assert.equal(changed, true);
    assert.equal(tools.length, 45);
    assert(tools.some(t => t.name === "delete_room"));
    assert(tools.find(t => t.name === "configure_sheet")!.inputSchema.properties!.titleBlockLayout);
  } finally { await client.close(); await server.close(); }
});

test("canvas captures reach clients as image content and malformed captures are rejected", async () => {
  let capture: unknown = { data: "aW1hZ2U=", mimeType: "image/png", scope: "Current canvas" };
  const server = createMcpServer(async () => capture);
  const client = new Client({ name: "capture-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "capture_canvas", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "Current canvas" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    capture = { data: "not base64!", mimeType: "image/png" };
    assert.equal((await client.callTool({ name: "capture_canvas", arguments: {} })).isError, true);
  } finally { await client.close(); await server.close(); }
});
