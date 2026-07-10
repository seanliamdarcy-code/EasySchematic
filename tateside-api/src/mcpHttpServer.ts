import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getConfig, type ApiConfig } from "./config.js";
import { McpLibraryError, type McpLibraryContext } from "./mcpLibrary.js";
import { createTateSideMcpServer, openMcpDatabase } from "./mcpServer.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface McpHttpHandle {
  server: Server;
  db: DatabaseSync;
  endpoint: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(
  config: Pick<ApiConfig, "dbPath" | "mcpLibraryEnabled" | "dynamicTaxonomyEnabled" | "libraryAuditEnabled" | "libraryDoctorEnabled" | "mcpHttpEnabled" | "mcpHttpHost" | "mcpHttpPort" | "mcpHttpAllowNonLoopback">,
): Promise<McpHttpHandle> {
  if (!config.mcpLibraryEnabled) throw new McpLibraryError("Set TATESIDE_MCP_LIBRARY_ENABLED=1 to enable MCP library tools");
  if (!config.mcpHttpEnabled) throw new McpLibraryError("Set TATESIDE_MCP_HTTP_ENABLED=1 to start the MCP HTTP server");
  if (!LOOPBACK_HOSTS.has(config.mcpHttpHost) && !config.mcpHttpAllowNonLoopback) {
    throw new McpLibraryError("Non-loopback MCP HTTP binds require TATESIDE_MCP_HTTP_ALLOW_NON_LOOPBACK=1");
  }

  const db = openMcpDatabase(config.dbPath);
  const context: McpLibraryContext = { db, config };
  const server = createServer(async (request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const mcpServer = createTateSideMcpServer(context);
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
    db.close();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.mcpHttpPort;
  const endpoint = `http://${config.mcpHttpHost.includes(":") ? `[${config.mcpHttpHost}]` : config.mcpHttpHost}:${port}/mcp`;
  return {
    server, db, endpoint,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

async function main(): Promise<void> {
  const handle = await startMcpHttpServer(getConfig());
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
