import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet } from "jose/jwks/remote";
import { jwtVerify } from "jose/jwt/verify";
import { getConfig, type ApiConfig } from "./config.js";
import { McpLibraryError, type McpLibraryContext } from "./mcpLibrary.js";
import { createTateSideMcpServer, openMcpDatabase, openOptionalHistoryDatabase, type McpToolLogger } from "./mcpServer.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const CLOUDFLARE_ACCESS_ALGORITHMS = ["RS256"];
const CLOUDFLARE_ACCESS_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const CLOUDFLARE_ACCESS_JWKS_COOLDOWN_MS = 30 * 1000;

type CloudflareAccessVerifier = (assertion: string) => Promise<boolean>;

export interface McpHttpHandle {
  server: Server;
  db: DatabaseSync;
  historyDb?: DatabaseSync | null;
  endpoint: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(
  config: Pick<ApiConfig, "dbPath" | "jetbuiltApiBaseUrl" | "jetbuiltIndexPath" | "mcpLibraryEnabled" | "dynamicTaxonomyEnabled" | "libraryAuditEnabled" | "libraryDoctorEnabled" | "mcpHttpEnabled" | "mcpHttpHost" | "mcpHttpPort" | "mcpHttpAllowNonLoopback" | "mcpLibraryDoctorProposalApiUrl" | "mcpLibraryDoctorProposalApiToken" | "mcpHttpCloudflareAccessEnabled" | "mcpHttpCloudflareAccessIssuer" | "mcpHttpCloudflareAccessAudience">,
  logToolCall?: McpToolLogger,
): Promise<McpHttpHandle> {
  if (!config.mcpLibraryEnabled) throw new McpLibraryError("Set TATESIDE_MCP_LIBRARY_ENABLED=1 to enable MCP library tools");
  if (!config.mcpHttpEnabled) throw new McpLibraryError("Set TATESIDE_MCP_HTTP_ENABLED=1 to start the MCP HTTP server");
  if (!LOOPBACK_HOSTS.has(config.mcpHttpHost) && !config.mcpHttpAllowNonLoopback) {
    throw new McpLibraryError("Non-loopback MCP HTTP binds require TATESIDE_MCP_HTTP_ALLOW_NON_LOOPBACK=1");
  }
  const verifyCloudflareAccess = createCloudflareAccessVerifier(config);

  const db = openMcpDatabase(config.dbPath);
  // Optional read-only Jetbuilt history DB for Phase 3 discovery tools.
  const historyDb = openOptionalHistoryDatabase();
  const context: McpLibraryContext = { db, config, historyDb, jetbuiltApiKey: process.env.JETBUILT_API_KEY?.trim() || null };
  const server = createServer(async (request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (verifyCloudflareAccess) {
      const assertion = request.headers[CLOUDFLARE_ACCESS_JWT_HEADER];
      const token = Array.isArray(assertion) ? assertion[0] : assertion;
      if (!token || !(await verifyCloudflareAccess(token))) {
        response.writeHead(401, {
          "cache-control": "no-store",
          "content-type": "application/json",
          "www-authenticate": "Bearer",
        }).end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    const mcpServer = createTateSideMcpServer(context, logToolCall);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    } finally {
      response.once("close", () => { void transport.close(); void mcpServer.close(); });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.mcpHttpPort, config.mcpHttpHost, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    historyDb?.close();
    db.close();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.mcpHttpPort;
  const endpoint = `http://${config.mcpHttpHost.includes(":") ? `[${config.mcpHttpHost}]` : config.mcpHttpHost}:${port}/mcp`;
  return {
    server, db, historyDb, endpoint,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      historyDb?.close();
      db.close();
    },
  };
}

function createCloudflareAccessVerifier(
  config: Pick<ApiConfig, "mcpHttpCloudflareAccessEnabled" | "mcpHttpCloudflareAccessIssuer" | "mcpHttpCloudflareAccessAudience">,
): CloudflareAccessVerifier | null {
  if (!config.mcpHttpCloudflareAccessEnabled) return null;
  const configuredIssuer = config.mcpHttpCloudflareAccessIssuer;
  const configuredAudience = config.mcpHttpCloudflareAccessAudience;
  if (!configuredIssuer || !configuredAudience) {
    throw new McpLibraryError(
      "Cloudflare Access authentication requires TATESIDE_MCP_HTTP_CLOUDFLARE_ACCESS_ISSUER and TATESIDE_MCP_HTTP_CLOUDFLARE_ACCESS_AUDIENCE",
    );
  }

  let issuer: URL;
  try {
    issuer = new URL(configuredIssuer);
  } catch {
    throw new McpLibraryError("Cloudflare Access issuer must be an absolute URL");
  }
  const remoteJwks = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", issuer),
    {
      cooldownDuration: CLOUDFLARE_ACCESS_JWKS_COOLDOWN_MS,
      cacheMaxAge: CLOUDFLARE_ACCESS_JWKS_CACHE_MAX_AGE_MS,
      timeoutDuration: 5000,
    },
  );
  return async (assertion: string): Promise<boolean> => {
    try {
      const { payload } = await jwtVerify(assertion, remoteJwks, {
        algorithms: CLOUDFLARE_ACCESS_ALGORITHMS,
        audience: configuredAudience,
        issuer: configuredIssuer,
      });
      return payload.exp != null;
    } catch {
      return false;
    }
  };
}

async function main(): Promise<void> {
  const handle = await startMcpHttpServer(getConfig(), (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  process.stdout.write(`TateSide MCP Streamable HTTP listening at ${handle.endpoint}\n`);
  const stop = () => { void handle.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1]?.endsWith("mcpHttpServer.js")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
