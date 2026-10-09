import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { DEFAULT_BRIDGE_PORT } from "./protocol.generated.js";

export function bridgeConfig() {
  const port = Number(process.env.EASYSCHEMATIC_MCP_PORT) || DEFAULT_BRIDGE_PORT;
  const tokenFile = process.env.EASYSCHEMATIC_MCP_TOKEN_FILE || join(homedir(), ".config", "easyschematic-mcp", "pairing-token");
  let token = process.env.EASYSCHEMATIC_MCP_TOKEN;
  if (!token) {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    try { writeFileSync(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    token = readFileSync(tokenFile, "utf8").trim();
    if (token.length < 32) throw new Error("Pairing token file is invalid; regenerate it before connecting.");
  }
  const allowedOrigins = (process.env.EASYSCHEMATIC_MCP_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return { port, token, tokenFile, allowedOrigins };
}
