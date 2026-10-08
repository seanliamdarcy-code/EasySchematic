import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { isOriginAllowed, tokensMatch } from "./security.js";
import { PROTOCOL_VERSION } from "./protocol.generated.js";

export interface BridgeOptions {
  port: number;
  token: string;
  allowedOrigins: string[];
  requestTimeoutMs?: number;
  log: (msg: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Hosts the localhost WebSocket the editor dials into, and relays MCP tool calls
 * to the single bound tab. Enforces the token + origin handshake and a one-active-
 * connection model (a new authenticated tab supersedes the previous one).
 */
export class AppBridge {
  private wss: WebSocketServer | null = null;
  private active: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private relay = false;
  private readonly relaySockets = new Set<WebSocket>();

  constructor(private readonly opts: BridgeOptions) {}

  async start(): Promise<void> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port });
    this.wss = server;
    server.on("connection", (ws, req) => this.onConnection(ws, req));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => { this.relay = false; resolve(); });
      server.once("error", (err: NodeJS.ErrnoException) => {
        this.wss = null;
        if (err.code === "EADDRINUSE") {
          this.relay = true;
          this.opts.log(`Sharing the EasySchematic bridge on port ${this.opts.port}.`);
          resolve();
        } else reject(err);
      });
    });
    server.on("error", (err) => this.opts.log(`WebSocket server error: ${err.message}`));
  }

  stop(): void {
    this.rejectAllPending(new Error("MCP server stopped."));
    for (const socket of this.wss?.clients ?? []) socket.terminate();
    for (const socket of this.relaySockets) socket.terminate();
    this.active = null;
    this.wss?.close();
    this.wss = null;
  }

  get connected(): boolean {
    return this.active !== null && this.active.readyState === WebSocket.OPEN;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!isOriginAllowed(req.headers.origin, this.opts.allowedOrigins)) {
      this.opts.log(`Rejected connection from disallowed origin: ${req.headers.origin ?? "(none)"}`);
      ws.close();
      return;
    }
    let helloed = false;

    ws.on("message", (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!helloed) {
        if (msg.type !== "hello" && msg.type !== "relay_call") {
          ws.close();
          return;
        }
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ type: "hello_ack", ok: false, reason: "Protocol version mismatch — update the MCP server." }));
          ws.close();
          return;
        }
        if (!tokensMatch(String(msg.token ?? ""), this.opts.token)) {
          ws.send(JSON.stringify({ type: "hello_ack", ok: false, reason: "Invalid pairing token." }));
          ws.close();
          return;
        }
        if (msg.type === "relay_call") {
          helloed = true;
          if (typeof msg.command !== "string" || !msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) {
            ws.close();
            return;
          }
          // Other stdio sessions share the editor without replacing its binding.
          void this.call(msg.command, msg.params as Record<string, unknown>).then(
            result => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "relay_result", ok: true, result })); },
            error => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "relay_result", ok: false, error: String(error.message) })); },
          );
          return;
        }
        helloed = true;
        // Single active binding: supersede any previously bound tab.
        if (this.active && this.active !== ws) {
          try {
            this.active.send(JSON.stringify({ type: "superseded", reason: "Another EasySchematic tab took the AI connection." }));
            this.active.close();
          } catch {
            /* ignore */
          }
          this.rejectAllPending(new Error("Connection superseded by a new tab."));
        }
        this.active = ws;
        ws.send(JSON.stringify({ type: "hello_ack", ok: true }));
        this.opts.log(`EasySchematic connected (schematic: ${String(msg.schematicName ?? "untitled")}).`);
        return;
      }

      if (ws !== this.active) return;
      if (msg.type === "response" && typeof msg.requestId === "string") {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        this.pending.delete(msg.requestId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "Command failed.")));
      }
    });

    ws.on("close", () => {
      if (this.active === ws) {
        this.active = null;
        this.rejectAllPending(new Error("EasySchematic disconnected."));
        this.opts.log("EasySchematic disconnected.");
      }
    });
    ws.on("error", () => {
      /* surfaced via the close handler */
    });
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a command to the bound tab and await its correlated response. */
  call(command: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.relay) return this.relayCall(command, params);
    if (!this.connected || !this.active) {
      return Promise.reject(
        new Error("No EasySchematic app is connected. Open the editor and turn on AI Assistant (MCP) in Preferences."),
      );
    }
    const requestId = `req-${++this.seq}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 15000;
    const socket = this.active;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for EasySchematic to handle "${command}".`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "command", requestId, command, params }));
    });
  }

  private relayCall(command: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.opts.port}`, { origin: "http://127.0.0.1" });
    this.relaySockets.add(socket);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.relaySockets.delete(socket);
        socket.close();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for the shared EasySchematic bridge to handle "${command}".`)), (this.opts.requestTimeoutMs ?? 15000) + 1000);
      socket.on("open", () => socket.send(JSON.stringify({ type: "relay_call", protocolVersion: PROTOCOL_VERSION, token: this.opts.token, command, params })));
      socket.on("message", data => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()); }
        catch { finish(new Error("Invalid response from the shared EasySchematic bridge.")); return; }
        if (msg.type !== "relay_result") {
          finish(new Error(String(msg.reason ?? "The running EasySchematic bridge must be updated to support multiple chats.")));
        } else if (msg.ok) finish(undefined, msg.result);
        else finish(new Error(String(msg.error ?? "Shared bridge command failed.")));
      });
      socket.on("error", error => finish(error));
      socket.on("close", () => finish(new Error("Shared EasySchematic bridge disconnected.")));
    });
  }
}
