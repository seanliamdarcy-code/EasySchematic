import express from "express";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { PROTOCOL_VERSION } from "./protocol.generated.js";

export interface OfficeIdentity { email: string; expires: number; subject?: string }
export type VerifyOfficeIdentity = (request: IncomingMessage) => Promise<OfficeIdentity>;

export function accessVerifier(issuer: URL, audience: string): VerifyOfficeIdentity {
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || !audience) throw new Error("Cloudflare Access issuer and audience are required.");
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), { timeoutDuration: 5000 });
  return async request => {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") throw new Error("Staff sign-in required.");
    const { payload } = await jwtVerify(assertion, keys, { algorithms: ["RS256"], issuer: issuer.origin, audience });
    if (typeof payload.email !== "string" || !payload.email.includes("@") || !payload.exp || !payload.sub) throw new Error("A staff identity is required.");
    return { email: payload.email.trim().toLowerCase(), expires: payload.exp * 1000, subject: payload.sub };
  };
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface Editor { socket: WebSocket; pending: Map<string, Pending> }

/** Cloudflare performs OAuth; signed Access assertions bind each call to its own editor. */
export function createOfficeService(verify: VerifyOfficeIdentity, editorOrigins: string[], log = console.info) {
  const editors = new Map<string, Editor>();
  const links = new Map<string, { expires: number; reason: string }>();
  const record = (event: string, identity: OfficeIdentity, detail: Record<string, unknown> = {}) =>
    log(JSON.stringify({ event, email: identity.email, subject: identity.subject, editorOrigins, ...detail }));
  const status = (email: string) => {
    const link = links.get(email);
    if (link && link.expires <= Date.now()) return { condition: "sign_in_expired", detail: "The linked editor's office sign-in expired. Reconnect in Preferences." };
    const editor = editors.get(email);
    if (editor?.socket.readyState === WebSocket.OPEN) return { condition: "connected", detail: "Office editor relay connected." };
    const current = links.get(email);
    return current
      ? { condition: "relay_not_connected", detail: current.reason }
      : { condition: "account_not_linked", detail: "No editor has linked this authenticated office account in this connector session." };
  };
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
    const state = status(email);
    if (!editor || state.condition !== "connected") {
      return Promise.reject(new Error(`[${state.condition}] ${state.detail} MCP account: ${email}. This connector serves ${editorOrigins.join(", ")}. Match the assistant's connector URL and account to Preferences → AI (Beta), then connect the open schematic. Reloading the editor turns pairing off. An unsaved or empty schematic is supported.`));
    }
    if (editor.pending.size >= 100) return Promise.reject(new Error("Too many outstanding editor commands."));
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { editor.pending.delete(requestId); reject(new Error("[editor_unresponsive] The linked editor did not answer within 30 seconds. Keep its tab open and reconnect in Preferences.")); }, 30000);
      editor.pending.set(requestId, { resolve, reject, timer });
      editor.socket.send(JSON.stringify({ type: "command", requestId, command, params }), error => {
        if (error) { clearTimeout(timer); editor.pending.delete(requestId); reject(new Error("Editor disconnected.")); }
      });
    });
  };
  app.get("/health", (_req, res) => res.json({ status: "ok", buildHash: process.env.EASYSCHEMATIC_BUILD_HASH ?? "development" }));
  app.get("/status", async (req, res) => {
    try {
      const identity = await verify(req);
      res.json({ ...status(identity.email), email: identity.email, editorOrigins, expires: identity.expires });
    } catch { res.status(401).json({ condition: "sign_in_required" }); }
  });
  app.get("/pair", async (req, res) => {
    try {
      const identity = await verify(req);
      const origin = typeof req.query.origin === "string" ? req.query.origin : "";
      if (!editorOrigins.includes(origin)) { res.status(403).end(); return; }
      for (const [email, link] of links) if (link.expires <= Date.now()) links.delete(email);
      if (!links.has(identity.email)) links.set(identity.email, { expires: identity.expires, reason: "Office sign-in completed, but the editor relay has not connected." });
      record("office_pair_sign_in", identity, { origin });
      const nonce = randomUUID();
      res.set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.set("Referrer-Policy", "no-referrer");
      res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Connect EasySchematic</title><style nonce="${nonce}">body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:1rem}button{padding:1rem;font:inherit}</style></head><body><h1>Connect this schematic</h1><p>Your AI assistant can read and edit the schematic in the editor tab that opened this window. Devices are published to the shared library only after review in Properties.</p><button id="connect">Connect my office account</button><p id="status"></p><script nonce="${nonce}">document.getElementById('connect').onclick=()=>{if(!window.opener){document.getElementById('status').textContent='Open this window from EasySchematic Preferences.';return;}window.opener.postMessage({type:'easyschematic-office-paired'},${JSON.stringify(origin)});window.close();};</script></body></html>`);
    } catch { res.status(401).end(); }
  });
  app.all("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    let identity: OfficeIdentity;
    try { identity = await verify(req); } catch { log(JSON.stringify({ event: "office_mcp_auth_rejected", editorOrigins })); res.status(401).end(); return; }
    if (req.headers.origin && !editorOrigins.includes(req.headers.origin) && !["https://grok.com", "https://x.ai"].includes(req.headers.origin)) { res.status(403).end(); return; }
    const mcp = createMcpServer((name, args) => {
      record("office_mcp_call", identity, { command: name, condition: status(identity.email).condition });
      return call(identity.email, name, args);
    });
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
            links.set(identity.email, { expires: identity.expires, reason: "The editor relay disconnected. Reconnect the open schematic in Preferences; reloading turns pairing off." });
            record("office_editor_connected", identity, { origin: request.headers.origin });
            ws.send(JSON.stringify({ type: "hello_ack", ok: true, officeEmail: identity.email })); return;
          }
          if (editors.get(identity.email) !== editor || message.type !== "response" || typeof message.requestId !== "string") return;
          const pending = editor.pending.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer); editor.pending.delete(message.requestId);
          if (message.ok === true) pending.resolve(message.result);
          else pending.reject(new Error(String(message.error ?? "Editor command failed.")));
        });
        ws.on("error", () => {});
        ws.on("close", (code, reason) => {
          clearTimeout(helloTimer); clearTimeout(expiryTimer);
          rejectPending(editor, "Editor disconnected.");
          if (editors.get(identity.email) === editor) {
            editors.delete(identity.email);
            if (code === 1008) links.set(identity.email, { expires: identity.expires, reason: "Office sign-in expired or the editor handshake was rejected. Reconnect in Preferences." });
            record("office_editor_disconnected", identity, { code, reason: reason.toString() });
          }
        });
      });
    })().catch(() => {
      log(JSON.stringify({ event: "office_editor_upgrade_rejected", editorOrigins, origin: request.headers.origin }));
      if (!socket.destroyed) socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    });
  });
  return { server, call, close: () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); } };
}
