#!/usr/bin/env node
/**
 * EasySchematic MCP server (Beta).
 *
 * Speaks MCP to Claude over stdio, and hosts a localhost WebSocket the running
 * editor connects to. Tool calls from Claude are relayed to the bound tab, which
 * executes them against the live schematic and replies.
 *
 * IMPORTANT: stdout is reserved for the MCP stdio protocol — all human-facing
 * logging goes to stderr.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AppBridge } from "./bridge.js";
import { TOOLS } from "./tools.js";
import { PROMPTS, getPrompt, SERVER_INSTRUCTIONS } from "./prompts.js";
import { DEFAULT_BRIDGE_PORT } from "./protocol.generated.js";

const log = (msg: string) => process.stderr.write(`[easyschematic-mcp] ${msg}\n`);

const port = Number(process.env.EASYSCHEMATIC_MCP_PORT) || DEFAULT_BRIDGE_PORT;
const tokenFile = process.env.EASYSCHEMATIC_MCP_TOKEN_FILE || join(homedir(), ".config", "easyschematic-mcp", "pairing-token");
function pairingToken(): string {
  if (process.env.EASYSCHEMATIC_MCP_TOKEN) return process.env.EASYSCHEMATIC_MCP_TOKEN;
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  try { writeFileSync(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const value = readFileSync(tokenFile, "utf8").trim();
  if (value.length < 32) throw new Error("Pairing token file is invalid; regenerate it before connecting.");
  return value;
}
const token = pairingToken();
const allowedOrigins = (process.env.EASYSCHEMATIC_MCP_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const bridge = new AppBridge({ port, token, allowedOrigins, log });
bridge.start();

log("");
log(`WebSocket bridge listening on ws://127.0.0.1:${port}`);
log(`Pairing token is stored in ${tokenFile}; it is never printed to logs.`);
log("Copy the token file contents into EasySchematic → Preferences → AI (Beta), then turn the toggle on.");
log("");

const server = new Server(
  { name: "easyschematic", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (req) =>
  getPrompt(req.params.name, req.params.arguments),
);

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await bridge.call(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log("MCP server ready (stdio). Waiting for the editor to connect…");

process.stdin.on("end", () => { bridge.stop(); void server.close(); });
