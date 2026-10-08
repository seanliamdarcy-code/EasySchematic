import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";

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
