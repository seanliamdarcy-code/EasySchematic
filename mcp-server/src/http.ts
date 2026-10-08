import { AppBridge } from "./bridge.js";
import { bridgeConfig } from "./config.js";
import { createHttpApp } from "./http-app.js";

const log = (message: string) => process.stderr.write(`[easyschematic-grok] ${message}\n`);
const config = bridgeConfig();
const bridge = new AppBridge({ ...config, log });
const publicUrl = new URL(process.env.EASYSCHEMATIC_MCP_PUBLIC_URL || "");
const httpPort = Number(process.env.EASYSCHEMATIC_MCP_HTTP_PORT || "8768");
if (!Number.isInteger(httpPort) || httpPort < 1024 || httpPort > 65535 || httpPort === config.port) throw new Error("Invalid HTTP port.");
const { app } = createHttpApp(publicUrl, config.token, (name, args) => bridge.call(name, args));
await bridge.start();
const listener = app.listen(httpPort, "127.0.0.1", () => log(`Connector ready: ${new URL("/mcp", publicUrl).href}; editor bridge port ${config.port}`));
listener.on("error", () => { bridge.stop(); process.exitCode = 1; log("Cannot start HTTP listener."); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { listener.close(); bridge.stop(); });
