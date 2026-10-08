import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { PROMPTS, getPrompt, SERVER_INSTRUCTIONS } from "./prompts.js";

export function createMcpServer(call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Server {
  const server = new Server({ name: "easyschematic", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => getPrompt(req.params.name, req.params.arguments));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
  return server;
}
