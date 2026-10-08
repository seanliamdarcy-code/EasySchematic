import express from "express";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { PROTOCOL_VERSION } from "./protocol.generated.js";

export interface OfficeIdentity { email: string; expires: number }
export type VerifyOfficeIdentity = (request: IncomingMessage) => Promise<OfficeIdentity>;

export function accessVerifier(issuer: URL, audience: string): VerifyOfficeIdentity {
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || !audience) throw new Error("Cloudflare Access issuer and audience are required.");
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), { timeoutDuration: 5000 });
  return async request => {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") throw new Error("Staff sign-in required.");
    const { payload } = await jwtVerify(assertion, keys, { algorithms: ["RS256"], issuer: issuer.origin, audience });
    if (typeof payload.email !== "string" || !payload.email.includes("@") || !payload.exp || !payload.sub) throw new Error("A staff identity is required.");
    return { email: payload.email.toLowerCase(), expires: payload.exp * 1000 };
  };
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface Editor { socket: WebSocket; pending: Map<string, Pending> }

/** Cloudflare performs OAuth; signed Access assertions bind each call to its own editor. */
export function createOfficeService(verify: VerifyOfficeIdentity, editorOrigins: string[]) {
  const editors = new Map<string, Editor>();
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const rejectPending = (editor: Editor, reason: string) => {
    for (const pending of editor.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    editor.pending.clear();
  };
  const call = (email: string, command: string, params: Record<string, unknown>) => {
    const editor = editors.get(email);
    if (!editor || editor.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Open EasySchematic Preferences and connect your office account to this schematic."));
    if (editor.pending.size >= 100) return Promise.reject(new Error("Too many outstanding editor commands."));
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { editor.pending.delete(requestId); reject(new Error("Editor command timed out.")); }, 30000);
      editor.pending.set(requestId, { resolve, reject, timer });
      editor.socket.send(JSON.stringify({ type: "command", requestId, command, params }), error => {
        if (error) { clearTimeout(timer); editor.pending.delete(requestId); reject(new Error("Editor disconnected.")); }
      });
    });
  };
  app.get("/health", (_req, res) => res.json({ status: "ok", buildHash: process.env.EASYSCHEMATIC_BUILD_HASH ?? "development" }));
  app.get("/pair", async (req, res) => {
    try {
      await verify(req);
      const origin = typeof req.query.origin === "string" ? req.query.origin : "";
      if (!editorOrigins.includes(origin)) { res.status(403).end(); return; }
      const nonce = randomUUID();
      res.set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.set("Referrer-Policy", "no-referrer");
      res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Connect EasySchematic</title><style nonce="${nonce}">body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:1rem}button{padding:1rem;font:inherit}</style></head><body><h1>Connect this schematic</h1><p>Your AI assistant can read and edit the schematic in the editor tab that opened this window. Devices are published to the shared library only after review in Properties.</p><button id="connect">Connect my office account</button><p id="status"></p><script nonce="${nonce}">document.getElementById('connect').onclick=()=>{if(!window.opener){document.getElementById('status').textContent='Open this window from EasySchematic Preferences.';return;}window.opener.postMessage({type:'easyschematic-office-paired'},${JSON.stringify(origin)});window.close();};</script></body></html>`);
    } catch { res.status(401).end(); }
  });
  app.all("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    let identity: OfficeIdentity;
    try { identity = await verify(req); } catch { res.status(401).end(); return; }
    if (req.headers.origin && !editorOrigins.includes(req.headers.origin) && !["https://grok.com", "https://x.ai"].includes(req.headers.origin)) { res.status(403).end(); return; }
    const mcp = createMcpServer((name, args) => call(identity.email, name, args));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: "MCP request failed." }); }
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (request.url !== "/editor" || !request.headers.origin || !editorOrigins.includes(request.headers.origin)) throw new Error("Origin rejected.");
      const identity = await verify(request);
      if (identity.expires <= Date.now()) throw new Error("Sign-in expired.");
      if (socket.destroyed) return;
      sockets.handleUpgrade(request, socket, head, ws => {
        const editor: Editor = { socket: ws, pending: new Map() };
        let helloed = false;
        const helloTimer = setTimeout(() => ws.close(1008, "Editor handshake required."), 5000);
        const expiryTimer = setTimeout(() => ws.close(1008, "Office sign-in expired. Reconnect in Preferences."), Math.min(identity.expires - Date.now(), 8 * 60 * 60 * 1000));
        ws.on("message", data => {
          let message: Record<string, unknown>;
          try { message = JSON.parse(data.toString()); if (!message || typeof message !== "object") throw new Error(); }
          catch { ws.close(1008, "Invalid editor message."); return; }
          if (!helloed) {
            if (message.type !== "hello" || message.protocolVersion !== PROTOCOL_VERSION) { ws.close(1008, "Protocol mismatch."); return; }
            clearTimeout(helloTimer); helloed = true;
            const previous = editors.get(identity.email);
            if (previous) {
              rejectPending(previous, "Another tab took your office connection.");
              previous.socket.send(JSON.stringify({ type: "superseded", reason: "Another tab took your office connection." }));
              previous.socket.close();
            }
            editors.set(identity.email, editor);
            ws.send(JSON.stringify({ type: "hello_ack", ok: true })); return;
          }
          if (editors.get(identity.email) !== editor || message.type !== "response" || typeof message.requestId !== "string") return;
          const pending = editor.pending.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer); editor.pending.delete(message.requestId);
          if (message.ok === true) pending.resolve(message.result);
          else pending.reject(new Error(String(message.error ?? "Editor command failed.")));
        });
        ws.on("error", () => {});
        ws.on("close", () => {
          clearTimeout(helloTimer); clearTimeout(expiryTimer);
          rejectPending(editor, "Editor disconnected.");
          if (editors.get(identity.email) === editor) editors.delete(identity.email);
        });
      });
    })().catch(() => { if (!socket.destroyed) socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); });
  });
  return { server, call, close: () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); } };
}
