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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppBridge } from "./bridge.js";
import { bridgeConfig } from "./config.js";
import { createMcpServer } from "./server.js";

const log = (msg: string) => process.stderr.write(`[easyschematic-mcp] ${msg}\n`);

const { port, token, tokenFile, allowedOrigins } = bridgeConfig();

const bridge = new AppBridge({ port, token, allowedOrigins, log });
await bridge.start();

log("");
log(`WebSocket bridge available on ws://127.0.0.1:${port}`);
log(`Pairing token is stored in ${tokenFile}; it is never printed to logs.`);
log("Copy the token file contents into EasySchematic → Preferences → AI (Beta), then turn the toggle on.");
log("");

const server = createMcpServer((name, args) => bridge.call(name, args));

await server.connect(new StdioServerTransport());
log("MCP server ready (stdio). Waiting for the editor to connect…");

process.stdin.on("end", () => { bridge.stop(); void server.close(); });
