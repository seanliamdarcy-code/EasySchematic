import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { PROMPTS, getPrompt, SERVER_INSTRUCTIONS } from "./prompts.js";

export function createMcpServer(call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Server {
  const server = new Server({ name: "easyschematic", version: "0.2.0" },
    { capabilities: { tools: { listChanged: true }, prompts: {} }, instructions: SERVER_INSTRUCTIONS });
  server.oninitialized = () => { void server.notification({ method: "notifications/tools/list_changed" }).catch(() => {}); };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => getPrompt(req.params.name, req.params.arguments));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      if (req.params.name === "capture_canvas") {
        const capture = result as { data?: unknown; mimeType?: unknown; scope?: unknown };
        if (capture?.mimeType !== "image/png" || typeof capture.data !== "string" || !capture.data.length || capture.data.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(capture.data)) throw new Error("Editor returned an invalid canvas image.");
        return { content: [{ type: "text", text: String(capture.scope ?? "Current schematic canvas") }, { type: "image", data: capture.data, mimeType: "image/png" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
  return server;
}
