import express, { type ErrorRequestHandler } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { GrokAuth } from "./grok-auth.js";

export function createHttpApp(publicUrl: URL, pairingToken: string, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error("Public URL must be an HTTPS origin.");
  }
  const resource = new URL("/mcp", publicUrl);
  const auth = new GrokAuth(pairingToken, resource);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // One workstation uses a global rate-limit bucket; do not trust tunnel-forwarded IPs.
    delete req.headers["x-forwarded-for"];
    if (req.headers.origin && req.headers.origin !== publicUrl.origin && !["https://grok.com", "https://x.ai"].includes(req.headers.origin)) {
      res.status(403).end(); return;
    }
    next();
  });
  app.use(mcpAuthRouter({ provider: auth, issuerUrl: publicUrl, resourceServerUrl: resource,
    scopesSupported: ["schematic"], resourceName: "EasySchematic workstation" }));
  app.post("/consent", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    if (req.headers.origin !== publicUrl.origin) { res.status(403).end(); return; }
    try {
      res.redirect(303, auth.consent(String(req.body.request ?? ""), String(req.body.token ?? ""), req.body.decision === "allow"));
    } catch { res.status(400).type("text").send("Authorization failed or expired. Restart the connection in Grok and check the pairing token."); }
  });
  app.all("/mcp", requireBearerAuth({ verifier: auth, requiredScopes: ["schematic"], resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).href }),
    express.json({ limit: "1mb" }), async (req, res) => {
      const server = createMcpServer(call);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: "MCP request failed." });
      }
    });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).json({ error: "Invalid request." });
  };
  app.use(errorHandler);
  return { app, auth };
}
