import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { getConfig } from "./config.js";
import { openDatabase, runMigrations } from "./db.js";
import { bulkDeleteTemplates, bulkEditTemplates, deleteTemplate, listCurrentTemplates, saveTemplates, updateTemplate } from "./deviceStore.js";
import type { ExtractedQuoteDevice, ProductBundleDefinition, ProductBundlePreviewRequest, QuoteImportResearchJobResponse, QuoteImportResearchResponse } from "../../src/quoteImportTypes.js";
import { listProductBundles, resolveProductBundle, saveProductBundle } from "./productBundleStore.js";
import {
  ensureJetbuiltIndexReady,
  getJetbuiltIndexStatus,
  importJetbuiltProject,
  initializeJetbuiltIndex,
  listLatestJetbuiltProjects,
  listJetbuiltProjectsForClient,
  previewProductBundleComponents,
  searchJetbuilt,
  searchJetbuiltClients,
  searchJetbuiltProjects,
} from "./jetbuilt.js";
import { researchQuoteDevices } from "./deviceResearch.js";
import { fallbackAiModels, getAiWorkflowConfig, hasAiProviderKey, listAiModels } from "./aiProvider.js";
import {
  SchematicStoreError,
  createSchematic,
  getCurrentSchematic,
  getSchematicVersion,
  listRecentSchematics,
  listSchematicVersions,
  restoreSchematicVersion,
  saveSchematic,
} from "./schematicStore.js";
import {
  createSharePointGraphClient,
  SharePointGraphError,
} from "./sharePointGraph.js";
import type { SharePointGraphClient } from "./sharePointGraph.js";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

interface ResearchJobRecord {
  jobId: string;
  fileName: string;
  status: QuoteImportResearchJobResponse["status"];
  total: number;
  completed: number;
  currentLabel: string | null;
  result: QuoteImportResearchResponse | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendEmpty(res: http.ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end();
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    function safeReject(err: unknown) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function safeResolve(val: Buffer) {
      if (settled) return;
      settled = true;
      resolve(val);
    }

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Bound memory: stop collecting and clear any prior chunks.
        chunks.length = 0;
        safeReject(new RequestError(413, "Request body is too large"));
        // Drain remaining request data safely (no destroy) so response can be sent.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      safeResolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      if (settled) return;
      safeReject(err);
    });

    // Early Content-Length check (for known-length bodies). Chunked bodies are still protected by accumulation below.
    const clHeader = req.headers["content-length"];
    if (clHeader != null) {
      const declared = parseInt(Array.isArray(clHeader) ? clHeader[0] : clHeader, 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        safeReject(new RequestError(413, "Request body is too large"));
        req.resume();
        return;
      }
    }
  });
}

async function readJson(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  try {
    const raw = (await readBody(req, maxBytes)).toString("utf8");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError(400, "Invalid JSON body");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPositiveSafeInteger(value: string | null, label: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new RequestError(400, `${label} must be a positive safe integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RequestError(400, `${label} must be a positive safe integer`);
  }

  return parsed;
}

async function readJsonObject(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const body = await readJson(req, maxBytes);
  if (!isObject(body)) {
    throw new RequestError(400, "Request body must be a JSON object");
  }
  return body;
}

function readSequenceFromBody(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    return readPositiveSafeInteger(value, "sequence");
  }
  throw new RequestError(400, "sequence must be a positive safe integer");
}

function accessEmail(req: http.IncomingMessage): string | null {
  const header = req.headers["cf-access-authenticated-user-email"];
  if (Array.isArray(header)) return header[0] ?? null;
  return header ?? null;
}

function makeCorsHeaders(origin: string | undefined, allowedOrigin: string): Record<string, string> {
  if (!origin) return {};
  if (origin !== allowedOrigin && !origin.startsWith("http://localhost:") && !origin.startsWith("http://127.0.0.1:")) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Vary": "Origin",
  };
}

function requireIdentity(ctx: RequestContext, requireAccessIdentity: boolean): string | null | undefined {
  const email = accessEmail(ctx.req);
  if (!requireAccessIdentity) return email;
  if (!email) {
    sendJson(ctx.res, 401, { error: "Cloudflare Access identity header is required" });
    return undefined;
  }
  return email;
}

const config = getConfig();
const db = openDatabase(config.dbPath);
runMigrations(db);
const quoteResearchJobs = new Map<string, ResearchJobRecord>();
if (process.env.JETBUILT_API_KEY) {
  initializeJetbuiltIndex({
    apiKey: process.env.JETBUILT_API_KEY,
    baseUrl: config.jetbuiltApiBaseUrl,
    indexPath: config.jetbuiltIndexPath,
    refreshMs: config.jetbuiltIndexRefreshMs,
  });
}

let sharePointClient: SharePointGraphClient | null = null;
if (config.sharePoint) {
  sharePointClient = createSharePointGraphClient(
    config.sharePoint,
    config.schematicMaxJsonBytes,
    config.sharePointMaxUploadBytes,
  );
}

function publicResearchJob(record: ResearchJobRecord): QuoteImportResearchJobResponse {
  return {
    jobId: record.jobId,
    status: record.status,
    fileName: record.fileName,
    total: record.total,
    completed: record.completed,
    currentLabel: record.currentLabel,
    result: record.result,
    error: record.error,
  };
}

function createResearchJobRecord(fileName: string, devices: ExtractedQuoteDevice[]): ResearchJobRecord {
  const now = new Date().toISOString();
  return {
    jobId: randomUUID(),
    fileName,
    status: "queued",
    total: devices.length,
    completed: 0,
    currentLabel: null,
    result: null,
    error: null,
    startedAt: now,
    updatedAt: now,
  };
}

function isApplicationPdf(contentTypeHeader: string | string[] | undefined): boolean {
  const rawValue = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  if (!rawValue) return false;
  const mediaType = rawValue.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/pdf";
}

const MAX_PAID_DEVICE_RESEARCH_BATCH_SIZE = 5;

async function runResearchJob(
  record: ResearchJobRecord,
  devices: ExtractedQuoteDevice[],
  forceEscalation: boolean,
  models: { researchModel?: string; escalationModel?: string } = {},
): Promise<void> {
  try {
    record.status = "running";
    record.updatedAt = new Date().toISOString();

    const aggregatedResults: QuoteImportResearchResponse["results"] = [];
    const warnings = new Set<string>();

    for (let index = 0; index < devices.length; index += 1) {
      const device = devices[index];
      record.currentLabel = `${device.manufacturer ? `${device.manufacturer} ` : ""}${device.model}`.trim();
      record.updatedAt = new Date().toISOString();

      const response = await researchQuoteDevices({
        fileName: record.fileName,
        devices: [device],
        forceEscalation,
        cachePath: config.quoteResearchCachePath,
        researchModel: models.researchModel,
        escalationModel: models.escalationModel,
      });

      aggregatedResults.push(...response.results);
      response.warnings.forEach((warning) => warnings.add(warning));
      record.completed = index + 1;
      record.result = {
        fileName: record.fileName,
        results: [...aggregatedResults],
        warnings: [...warnings],
      };
      record.updatedAt = new Date().toISOString();
    }

    record.status = "complete";
    record.result = {
      fileName: record.fileName,
      results: [...aggregatedResults],
      warnings: [...warnings],
    };
    record.currentLabel = null;
    record.updatedAt = new Date().toISOString();
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : "Research failed";
    record.updatedAt = new Date().toISOString();
  }
}

async function handleRequest(ctx: RequestContext): Promise<void> {
  const corsHeaders = makeCorsHeaders(ctx.req.headers.origin, config.allowedOrigin);

  if (ctx.req.method === "OPTIONS") {
    sendEmpty(ctx.res, 204, corsHeaders);
    return;
  }

  const path = ctx.url.pathname;

  if (ctx.req.method === "GET" && path === "/health") {
    sendJson(ctx.res, 200, { ok: true, service: "tateside-api" }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/ai/settings") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    const workflow = getAiWorkflowConfig();
    let models = fallbackAiModels();
    let modelListError: string | null = null;
    try {
      models = await listAiModels();
    } catch (err) {
      modelListError = err instanceof Error ? err.message : "OpenRouter model list could not be loaded";
    }

    sendJson(ctx.res, 200, {
      provider: "openrouter",
      configured: hasAiProviderKey(),
      defaults: workflow,
      models,
      modelListError,
    }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/devices/templates") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    sendJson(ctx.res, 200, listCurrentTemplates(db), corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/product-bundles") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;
    sendJson(ctx.res, 200, { bundles: listProductBundles(db) }, corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/product-bundles") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;
    const body = await readJson(ctx.req) as ProductBundleDefinition | null;
    if (!body) throw new RequestError(400, "Bundle definition is required");
    const bundle = saveProductBundle(db, body);
    sendJson(ctx.res, 201, { bundle }, corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/product-bundles/preview") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;
    const body = await readJson(ctx.req) as ProductBundlePreviewRequest | null;
    if (!body) throw new RequestError(400, "Bundle preview request is required");
    sendJson(ctx.res, 200, { components: previewProductBundleComponents(db, body) }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/product-bundles/resolve") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;
    const manufacturer = ctx.url.searchParams.get("manufacturer");
    const sku = ctx.url.searchParams.get("sku");
    sendJson(ctx.res, 200, { bundle: resolveProductBundle(db, manufacturer, sku) }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/schematics") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;
    sendJson(ctx.res, 200, listRecentSchematics(db), corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/schematics") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const body = await readJsonObject(ctx.req, config.schematicMaxJsonBytes);
    const created = createSchematic(db, config.schematicRepositoryPath, config.schematicMaxJsonBytes, {
      schematic: body.data,
      source: typeof body.source === "string" ? body.source : undefined,
      actorEmail: email,
    });
    sendJson(ctx.res, 201, created, corsHeaders);
    return;
  }

  const schematicVersionMatch = path.match(/^\/api\/tateside\/schematics\/([^/]+)\/versions\/([^/]+)$/);
  if (ctx.req.method === "GET" && schematicVersionMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const schematicId = decodeURIComponent(schematicVersionMatch[1]);
    const sequence = readPositiveSafeInteger(decodeURIComponent(schematicVersionMatch[2]), "sequence");
    sendJson(ctx.res, 200, getSchematicVersion(db, config.schematicRepositoryPath, schematicId, sequence), corsHeaders);
    return;
  }

  const schematicRestoreMatch = path.match(/^\/api\/tateside\/schematics\/([^/]+)\/restore$/);
  if (ctx.req.method === "POST" && schematicRestoreMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const schematicId = decodeURIComponent(schematicRestoreMatch[1]);
    const body = await readJsonObject(ctx.req, config.schematicMaxJsonBytes);
    const sequence = readSequenceFromBody(body.sequence);
    const restored = restoreSchematicVersion(
      db,
      config.schematicRepositoryPath,
      config.schematicMaxJsonBytes,
      schematicId,
      sequence,
      {
        source: typeof body.source === "string" ? body.source : undefined,
        actorEmail: email,
      },
    );
    sendJson(ctx.res, 200, restored, corsHeaders);
    return;
  }

  const schematicVersionsMatch = path.match(/^\/api\/tateside\/schematics\/([^/]+)\/versions$/);
  if (ctx.req.method === "GET" && schematicVersionsMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const schematicId = decodeURIComponent(schematicVersionsMatch[1]);
    sendJson(ctx.res, 200, listSchematicVersions(db, schematicId), corsHeaders);
    return;
  }

  const schematicMatch = path.match(/^\/api\/tateside\/schematics\/([^/]+)$/);
  if (schematicMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const schematicId = decodeURIComponent(schematicMatch[1]);

    if (ctx.req.method === "GET") {
      sendJson(ctx.res, 200, getCurrentSchematic(db, config.schematicRepositoryPath, schematicId), corsHeaders);
      return;
    }

    if (ctx.req.method === "PUT") {
      const body = await readJsonObject(ctx.req, config.schematicMaxJsonBytes);
      const saved = saveSchematic(db, config.schematicRepositoryPath, config.schematicMaxJsonBytes, schematicId, {
        schematic: body.data,
        source: typeof body.source === "string" ? body.source : undefined,
        actorEmail: email,
      });
      sendJson(ctx.res, 200, saved, corsHeaders);
      return;
    }
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/devices/templates") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const body = await readJson(ctx.req) as { templates?: unknown[]; note?: unknown; source?: unknown } | null;
    const templates = saveTemplates(db, {
      templates: body?.templates ?? [],
      note: typeof body?.note === "string" ? body.note : undefined,
      source: typeof body?.source === "string" ? body.source : undefined,
      actorEmail: email,
    });
    sendJson(ctx.res, 201, { templates }, corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/devices/templates/bulk-edit") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const body = await readJson(ctx.req) as {
      templateIds?: unknown;
      setManufacturer?: unknown;
      setCategory?: unknown;
      removeLabelPrefix?: unknown;
      findLabelText?: unknown;
      replaceLabelText?: unknown;
      note?: unknown;
      source?: unknown;
      preview?: unknown;
    } | null;

    const result = bulkEditTemplates(db, {
      templateIds: body?.templateIds,
      setManufacturer: body?.setManufacturer,
      setCategory: body?.setCategory,
      removeLabelPrefix: body?.removeLabelPrefix,
      findLabelText: body?.findLabelText,
      replaceLabelText: body?.replaceLabelText,
      preview: body?.preview === true,
      note: typeof body?.note === "string" ? body.note : undefined,
      source: typeof body?.source === "string" ? body.source : undefined,
      actorEmail: email,
    });
    sendJson(ctx.res, body?.preview === true ? 200 : 201, result, corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/devices/templates/bulk-delete") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const body = await readJson(ctx.req) as {
      templateIds?: unknown;
      note?: unknown;
      source?: unknown;
    } | null;

    const result = bulkDeleteTemplates(db, {
      templateIds: body?.templateIds,
      note: typeof body?.note === "string" ? body.note : undefined,
      source: typeof body?.source === "string" ? body.source : undefined,
      actorEmail: email,
    });
    sendJson(ctx.res, 201, result, corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/quote-import/extract") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    sendJson(ctx.res, 410, {
      error: "PDF quote extraction is no longer active. Use the Jetbuilt project import workflow instead.",
    }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/jetbuilt/projects") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    await ensureJetbuiltIndexReady({
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    const latest = ctx.url.searchParams.get("latest") === "true";
    const query = (ctx.url.searchParams.get("query") ?? "").trim();
    const limit = Number(ctx.url.searchParams.get("limit") ?? "25");
    const offset = Number(ctx.url.searchParams.get("offset") ?? "0");
    const projects = latest
      ? listLatestJetbuiltProjects(Number.isFinite(limit) ? limit : 25, Number.isFinite(offset) ? offset : 0)
      : query
        ? searchJetbuiltProjects(query)
        : [];
    const status = getJetbuiltIndexStatus();
    if (latest && projects.length === 0 && status.lastError) {
      sendJson(ctx.res, 502, { error: `Jetbuilt project index could not be refreshed: ${status.lastError}` }, corsHeaders);
      return;
    }
    sendJson(ctx.res, 200, { projects }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/jetbuilt/search") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    const query = (ctx.url.searchParams.get("query") ?? "").trim();
    if (!query) {
      sendJson(ctx.res, 200, { projects: [], clients: [] }, corsHeaders);
      return;
    }

    await ensureJetbuiltIndexReady({
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    sendJson(ctx.res, 200, searchJetbuilt(query), corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/jetbuilt/clients") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    const query = (ctx.url.searchParams.get("query") ?? "").trim();
    if (!query) {
      sendJson(ctx.res, 200, { clients: [] }, corsHeaders);
      return;
    }

    await ensureJetbuiltIndexReady({
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    const clients = searchJetbuiltClients(query);
    sendJson(ctx.res, 200, { clients }, corsHeaders);
    return;
  }

  const clientProjectsMatch = path.match(/^\/api\/tateside\/jetbuilt\/clients\/([^/]+)\/projects$/);
  if (ctx.req.method === "GET" && clientProjectsMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    await ensureJetbuiltIndexReady({
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    const clientId = decodeURIComponent(clientProjectsMatch[1]);
    const projects = listJetbuiltProjectsForClient(clientId);
    sendJson(ctx.res, 200, { projects }, corsHeaders);
    return;
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/jetbuilt/status") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    await ensureJetbuiltIndexReady({
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    sendJson(ctx.res, 200, getJetbuiltIndexStatus(), corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/jetbuilt/import") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!process.env.JETBUILT_API_KEY) {
      sendJson(ctx.res, 503, {
        error: "Import from Jetbuilt Project is not available because JETBUILT_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    const body = await readJson(ctx.req) as { projectId?: unknown } | null;
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) {
      sendJson(ctx.res, 400, { error: "Jetbuilt projectId is required" }, corsHeaders);
      return;
    }

    const result = await importJetbuiltProject(db, projectId, {
      apiKey: process.env.JETBUILT_API_KEY,
      baseUrl: config.jetbuiltApiBaseUrl,
      indexPath: config.jetbuiltIndexPath,
      refreshMs: config.jetbuiltIndexRefreshMs,
    });
    sendJson(ctx.res, 200, result, corsHeaders);
    return;
  }

  const researchJobMatch = path.match(/^\/api\/tateside\/quote-import\/research\/([^/]+)$/);
  if (ctx.req.method === "GET" && researchJobMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    const jobId = decodeURIComponent(researchJobMatch[1]);
    const job = quoteResearchJobs.get(jobId);
    if (!job) {
      sendJson(ctx.res, 404, { error: "Quote research job not found" }, corsHeaders);
      return;
    }
    sendJson(ctx.res, 200, publicResearchJob(job), corsHeaders);
    return;
  }

  if (ctx.req.method === "POST" && path === "/api/tateside/quote-import/research") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!hasAiProviderKey()) {
      sendJson(ctx.res, 503, {
        error: "AI research is not available because OPENROUTER_API_KEY is not configured on the TateSide API server",
      }, corsHeaders);
      return;
    }

    const body = await readJson(ctx.req) as {
      fileName?: unknown;
      devices?: unknown[];
      forceEscalation?: unknown;
      researchModel?: unknown;
      escalationModel?: unknown;
    } | null;

    const fileName = typeof body?.fileName === "string" && body.fileName.trim() ? body.fileName.trim() : "quote.pdf";
    const devices = Array.isArray(body?.devices) ? body.devices as ExtractedQuoteDevice[] : [];

    if (devices.length === 0) {
      sendJson(ctx.res, 400, { error: "At least one missing device is required for research" }, corsHeaders);
      return;
    }

    if (devices.length > MAX_PAID_DEVICE_RESEARCH_BATCH_SIZE) {
      sendJson(ctx.res, 400, {
        error: "Paid AI research is limited to 5 devices per batch. Select a smaller batch and run the next group separately.",
      }, corsHeaders);
      return;
    }

    const job = createResearchJobRecord(fileName, devices);
    quoteResearchJobs.set(job.jobId, job);
    void runResearchJob(job, devices, body?.forceEscalation === true, {
      researchModel: typeof body?.researchModel === "string" ? body.researchModel.trim() : undefined,
      escalationModel: typeof body?.escalationModel === "string" ? body.escalationModel.trim() : undefined,
    });
    sendJson(ctx.res, 202, publicResearchJob(job), corsHeaders);
    return;
  }

  const templateMatch = path.match(/^\/api\/tateside\/devices\/templates\/([^/]+)$/);
  if (templateMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    const deviceId = decodeURIComponent(templateMatch[1]);

    if (ctx.req.method === "PUT") {
      const body = await readJson(ctx.req) as { template?: unknown; note?: unknown; source?: unknown } | null;
      const template = updateTemplate(db, deviceId, {
        template: body?.template,
        note: typeof body?.note === "string" ? body.note : undefined,
        source: typeof body?.source === "string" ? body.source : undefined,
        actorEmail: email,
      });
      sendJson(ctx.res, 200, { template }, corsHeaders);
      return;
    }

    if (ctx.req.method === "DELETE") {
      const body = ctx.req.headers["content-length"] && ctx.req.headers["content-length"] !== "0"
        ? await readJson(ctx.req) as { note?: unknown } | null
        : null;
      deleteTemplate(db, deviceId, {
        actorEmail: email,
        note: typeof body?.note === "string" ? body.note : undefined,
      });
      sendEmpty(ctx.res, 204, corsHeaders);
      return;
    }
  }

  if (ctx.req.method === "GET" && path === "/api/tateside/sharepoint/children") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!config.sharePoint || !sharePointClient) {
      sendJson(ctx.res, 503, { error: "SharePoint is not configured on the TateSide API server" }, corsHeaders);
      return;
    }

    const rawFolderId = ctx.url.searchParams.get("folderId");
    const folderIdArg = rawFolderId && rawFolderId.trim() ? rawFolderId : null;
    const list = await sharePointClient.listFolderChildren(folderIdArg);

    const rootId = config.sharePoint.rootFolderId;
    const isRoot = list.folder.id === rootId;
    const outFolderId = isRoot ? null : list.folder.id;
    const outFolderName = list.folder.name;

    const outBreadcrumbs = list.breadcrumbs.map((bc) => ({
      id: bc.id === rootId ? null : bc.id,
      name: bc.name,
    }));

    let outParentId: string | null = null;
    if (outBreadcrumbs.length >= 2) {
      outParentId = outBreadcrumbs[outBreadcrumbs.length - 2].id;
    }

    const outItems = list.items.map((item) => {
      const out: { id: string; name: string; type: "file" | "folder"; webUrl?: string; size?: number; lastModifiedDateTime?: string } = {
        id: item.id,
        name: item.name,
        type: item.type,
      };
      if (item.webUrl != null) out.webUrl = item.webUrl;
      if (typeof item.size === "number") out.size = item.size;
      if (item.lastModifiedDateTime != null) out.lastModifiedDateTime = item.lastModifiedDateTime;
      return out;
    });

    sendJson(ctx.res, 200, {
      folderId: outFolderId,
      folderName: outFolderName,
      parentId: outParentId,
      breadcrumbs: outBreadcrumbs,
      items: outItems,
    }, corsHeaders);
    return;
  }

  if (ctx.req.method === "PUT" && path === "/api/tateside/sharepoint/schematics") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!config.sharePoint || !sharePointClient) {
      sendJson(ctx.res, 503, { error: "SharePoint is not configured on the TateSide API server" }, corsHeaders);
      return;
    }

    const bodyLimit = config.schematicMaxJsonBytes + 65536;
    const body = await readJsonObject(ctx.req, bodyLimit);
    const folderId = body.folderId;
    if (folderId != null && typeof folderId !== "string") {
      throw new RequestError(400, "folderId must be null, undefined or a string");
    }
    if (typeof body.fileName !== "string") {
      throw new RequestError(400, "fileName must be a string");
    }
    if (body.data === undefined) {
      throw new RequestError(400, "data is required");
    }

    const saved = await sharePointClient.uploadSchematic(folderId, body.fileName, body.data);
    const meta: { id: string; name: string; webUrl?: string; lastModifiedDateTime?: string } = {
      id: saved.id,
      name: saved.name,
    };
    if (saved.webUrl != null) meta.webUrl = saved.webUrl;
    if (saved.lastModifiedDateTime != null) meta.lastModifiedDateTime = saved.lastModifiedDateTime;
    sendJson(ctx.res, 200, meta, corsHeaders);
    return;
  }

  if (ctx.req.method === "PUT" && path === "/api/tateside/sharepoint/pdfs") {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!config.sharePoint || !sharePointClient) {
      sendJson(ctx.res, 503, { error: "SharePoint is not configured on the TateSide API server" }, corsHeaders);
      return;
    }

    const contentTypeHeader = ctx.req.headers["content-type"];
    if (!contentTypeHeader) {
      throw new RequestError(400, "Content-Type must be application/pdf");
    }
    if (!isApplicationPdf(contentTypeHeader)) {
      throw new RequestError(415, "Content-Type must be application/pdf");
    }

    const rawFolderId = ctx.url.searchParams.get("folderId");
    const folderId = rawFolderId == null || rawFolderId === "" ? null : rawFolderId;
    const fileName = ctx.url.searchParams.get("fileName");
    if (!fileName) {
      throw new RequestError(400, "fileName is required");
    }

    const pdfBytes = new Uint8Array(await readBody(ctx.req, config.sharePointMaxUploadBytes));
    const saved = await sharePointClient.uploadPdf(folderId, fileName, pdfBytes);
    const meta: { id: string; name: string; webUrl?: string; lastModifiedDateTime?: string } = {
      id: saved.id,
      name: saved.name,
    };
    if (saved.webUrl != null) meta.webUrl = saved.webUrl;
    if (saved.lastModifiedDateTime != null) meta.lastModifiedDateTime = saved.lastModifiedDateTime;
    sendJson(ctx.res, 200, meta, corsHeaders);
    return;
  }

  const sharePointSchematicMatch = path.match(/^\/api\/tateside\/sharepoint\/schematics\/([^/]+)$/);
  if (ctx.req.method === "GET" && sharePointSchematicMatch) {
    const email = requireIdentity(ctx, config.requireAccessIdentity);
    if (email === undefined) return;
    void email;

    if (!config.sharePoint || !sharePointClient) {
      sendJson(ctx.res, 503, { error: "SharePoint is not configured on the TateSide API server" }, corsHeaders);
      return;
    }

    let fileId: string;
    try {
      fileId = decodeURIComponent(sharePointSchematicMatch[1]);
    } catch {
      throw new RequestError(400, "file id is invalid");
    }
    const data = await sharePointClient.downloadSchematic(fileId);
    sendJson(ctx.res, 200, data, corsHeaders);
    return;
  }

  sendJson(ctx.res, 404, { error: "Not found" }, corsHeaders);
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || `${config.host}:${config.port}`;
  const ctx: RequestContext = {
    req,
    res,
    url: new URL(req.url || "/", `http://${host}`),
  };

  handleRequest(ctx).catch((err) => {
    const corsHeaders = makeCorsHeaders(req.headers.origin, config.allowedOrigin);
    if (err instanceof SchematicStoreError) {
      sendJson(res, err.status, { error: err.message }, corsHeaders);
      return;
    }
    if (err instanceof RequestError) {
      sendJson(res, err.status, { error: err.message }, corsHeaders);
      return;
    }
    if (err instanceof SharePointGraphError) {
      sendJson(res, err.status, { error: err.message }, corsHeaders);
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("invalid") || message.includes("required") || message.includes("large") ? 400 : 500;
    sendJson(res, status, { error: status === 400 ? message : "Internal server error" }, corsHeaders);
  });
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`TateSide API listening on http://${config.host}:${config.port}\n`);
  process.stdout.write(`SQLite database: ${config.dbPath}\n`);
});
