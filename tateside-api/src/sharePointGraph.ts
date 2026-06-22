import type { SchematicFile } from "../../src/types.js";
import type { SharePointConfig } from "./config.js";

const DEFAULT_TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_CONTAINMENT_MAX_DEPTH = 32;
const DEFAULT_CHILDREN_PAGE_SIZE = 100;
const MAX_CHILDREN_PAGE_SIZE = 200;
const MAX_FILENAME_LENGTH = 180;
const MAX_JSON_DEPTH = 64;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const RESERVED_FILENAME_CHARACTER_PATTERN = /[<>:"|?*]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class SharePointGraphError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SharePointGraphError";
    this.status = status;
  }
}

export interface SharePointGraphItem {
  id: string;
  name: string;
  type: "file" | "folder";
  webUrl: string | null;
  size: number;
  lastModifiedDateTime: string | null;
}

export interface SharePointGraphListResult {
  folder: SharePointGraphItem;
  breadcrumbs: SharePointGraphItem[];
  items: SharePointGraphItem[];
  nextPageToken: string | null;
}

export interface SharePointGraphClient {
  listFolderChildren(folderId?: string | null, options?: { pageSize?: number; pageToken?: string | null }): Promise<SharePointGraphListResult>;
  uploadSchematic(
    folderId: string | null | undefined,
    fileName: string,
    schematic: unknown,
  ): Promise<SharePointGraphItem>;
  downloadSchematic(fileId: string): Promise<SchematicFile>;
  resolveMetadata(itemId: string): Promise<SharePointGraphItem>;
}

interface SharePointGraphClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  tokenExpirySkewMs?: number;
  containmentMaxDepth?: number;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

interface GraphErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface GraphParentReference {
  driveId?: string;
  siteId?: string;
  id?: string;
}

interface GraphItemPayload {
  id?: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  parentReference?: GraphParentReference;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
}

interface GraphChildrenPayload {
  value?: unknown;
  "@odata.nextLink"?: unknown;
}

interface ContainedItem {
  item: SharePointGraphItem;
  raw: RequiredGraphItemPayload;
}

interface ItemLineage {
  current: ContainedItem;
  breadcrumbs: SharePointGraphItem[];
}

interface RequiredGraphItemPayload extends GraphItemPayload {
  id: string;
  name: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function assertSafeItemId(itemId: string, label: string): string {
  const value = itemId.trim();
  if (!value || value.length > 256 || containsControlCharacters(value) || PATH_SEPARATOR_PATTERN.test(value)) {
    throw new SharePointGraphError(400, `${label} is invalid`);
  }
  return value;
}

function assertFolderId(folderId: string): string {
  return assertSafeItemId(folderId, "folder id");
}

function assertFileId(fileId: string): string {
  return assertSafeItemId(fileId, "file id");
}

function assertJsonFileName(fileName: string): string {
  const value = fileName;
  if (!value.trim()) {
    throw new SharePointGraphError(400, "file name is required");
  }
  if (value.length > MAX_FILENAME_LENGTH) {
    throw new SharePointGraphError(400, `file name exceeds ${MAX_FILENAME_LENGTH} characters`);
  }
  if (value.endsWith(".") || value.endsWith(" ")) {
    throw new SharePointGraphError(400, "file name must not end with a dot or space");
  }
  if (value === "." || value === "..") {
    throw new SharePointGraphError(400, "file name is invalid");
  }
  if (
    containsControlCharacters(value)
    || PATH_SEPARATOR_PATTERN.test(value)
    || RESERVED_FILENAME_CHARACTER_PATTERN.test(value)
  ) {
    throw new SharePointGraphError(400, "file name contains invalid characters");
  }
  if (!/^[^.].*\.json$/i.test(value)) {
    throw new SharePointGraphError(400, "file name must end with .json");
  }
  return value;
}

function canonicalizeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new SharePointGraphError(400, `schematic JSON exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`);
  }
  if (isSafeJsonPrimitive(value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SharePointGraphError(400, "schematic JSON must not contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, depth + 1));
  }
  if (!isObject(value)) {
    throw new SharePointGraphError(400, "schematic JSON must contain only JSON-compatible values");
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalizeJson(value[key], depth + 1);
  }
  return output;
}

function validateSchematicShape(input: unknown, maxJsonBytes: number): { data: SchematicFile; json: string } {
  if (!isObject(input)) {
    throw new SharePointGraphError(400, "schematic must be an object");
  }
  if (typeof input.version !== "number" || !Number.isFinite(input.version)) {
    throw new SharePointGraphError(400, "schematic.version must be a number");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new SharePointGraphError(400, "schematic.name must be a non-empty string");
  }
  if (!Array.isArray(input.nodes)) {
    throw new SharePointGraphError(400, "schematic.nodes must be an array");
  }
  if (!Array.isArray(input.edges)) {
    throw new SharePointGraphError(400, "schematic.edges must be an array");
  }

  const canonicalData = canonicalizeJson(input) as SchematicFile;
  const json = JSON.stringify(canonicalData);
  const sizeBytes = Buffer.byteLength(json);
  if (sizeBytes > maxJsonBytes) {
    throw new SharePointGraphError(400, `schematic JSON exceeds ${maxJsonBytes} bytes`);
  }

  return { data: canonicalData, json };
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize == null) {
    return DEFAULT_CHILDREN_PAGE_SIZE;
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_CHILDREN_PAGE_SIZE) {
    throw new SharePointGraphError(400, `pageSize must be an integer between 1 and ${MAX_CHILDREN_PAGE_SIZE}`);
  }
  return pageSize;
}

function mapGraphItem(payload: GraphItemPayload): SharePointGraphItem {
  const id = typeof payload.id === "string" ? payload.id : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  if (!id || !name) {
    throw new SharePointGraphError(502, "SharePoint returned an invalid item payload");
  }
  if (!!payload.folder === !!payload.file) {
    throw new SharePointGraphError(502, "SharePoint item type was invalid");
  }

  return {
    id,
    name,
    type: payload.folder ? "folder" : "file",
    webUrl: typeof payload.webUrl === "string" ? payload.webUrl : null,
    size: typeof payload.size === "number" && Number.isFinite(payload.size) ? payload.size : 0,
    lastModifiedDateTime: typeof payload.lastModifiedDateTime === "string" ? payload.lastModifiedDateTime : null,
  };
}

function mapGraphStatus(responseStatus: number, errorCode: string | null): number {
  if (responseStatus === 400) {
    return 400;
  }
  if (responseStatus === 403) {
    return 403;
  }
  if (responseStatus === 404) {
    return 404;
  }
  if (responseStatus === 409) {
    return 409;
  }
  if (errorCode === "accessDenied") {
    return 403;
  }
  if (errorCode === "itemNotFound") {
    return 404;
  }
  if (errorCode === "invalidRequest" || errorCode === "badRequest") {
    return 400;
  }
  return 502;
}

function mapGraphMessage(responseStatus: number, errorCode: string | null): string {
  if (responseStatus === 404 || errorCode === "itemNotFound") {
    return "SharePoint item not found";
  }
  if (responseStatus === 403 || errorCode === "accessDenied") {
    return "SharePoint access denied";
  }
  if (responseStatus === 400 || errorCode === "invalidRequest" || errorCode === "badRequest") {
    return "SharePoint request was invalid";
  }
  if (responseStatus === 401) {
    return "SharePoint authentication failed";
  }
  return "SharePoint request failed";
}

function decodePageToken(pageToken: string): string {
  const value = pageToken.trim();
  if (!value || !BASE64URL_PATTERN.test(value)) {
    throw new SharePointGraphError(400, "page token is invalid");
  }

  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new SharePointGraphError(400, "page token is invalid");
  }
  if (!decoded || containsControlCharacters(decoded)) {
    throw new SharePointGraphError(400, "page token is invalid");
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
    throw new SharePointGraphError(400, "page token is invalid");
  }
  return decoded;
}

function encodePageToken(nextLink: string): string {
  return Buffer.from(nextLink, "utf8").toString("base64url");
}

function selectFields(): string {
  return "id,name,webUrl,size,lastModifiedDateTime,parentReference,folder,file";
}

export function createSharePointGraphClient(
  sharePoint: SharePointConfig,
  schematicMaxJsonBytes: number,
  options: SharePointGraphClientOptions = {},
): SharePointGraphClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const now = options.now ?? Date.now;
  const tokenExpirySkewMs = Math.max(1_000, options.tokenExpirySkewMs ?? DEFAULT_TOKEN_EXPIRY_SKEW_MS);
  const containmentMaxDepth = Math.max(1, options.containmentMaxDepth ?? DEFAULT_CONTAINMENT_MAX_DEPTH);
  const graphBaseUrl = sharePoint.graphBaseUrl.replace(/\/$/, "");
  const identityBaseUrl = sharePoint.identityBaseUrl.replace(/\/$/, "");
  const graphBase = new URL(graphBaseUrl);
  const allowHttpGraphUrls = graphBase.protocol === "http:";
  const graphPathPrefix = graphBase.pathname.endsWith("/")
    ? graphBase.pathname
    : `${graphBase.pathname}/`;
  const graphScopeBase = (() => {
    if (graphBase.pathname === "/v1.0" || graphBase.pathname === "/beta") {
      return graphBase.origin;
    }
    return `${graphBase.origin}${graphBase.pathname.replace(/\/$/, "")}`;
  })();

  let tokenCache: TokenCacheEntry | null = null;

  async function safeFetch(input: URL | string, init: RequestInit, message = "SharePoint request failed"): Promise<Response> {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (error instanceof SharePointGraphError) {
        throw error;
      }
      throw new SharePointGraphError(502, message);
    }
  }

  async function readGraphError(response: Response): Promise<never> {
    let errorCode: string | null = null;
    try {
      const body = await response.json() as GraphErrorBody;
      errorCode = typeof body.error?.code === "string" ? body.error.code : null;
    } catch {
      errorCode = null;
    }
    throw new SharePointGraphError(
      mapGraphStatus(response.status, errorCode),
      mapGraphMessage(response.status, errorCode),
    );
  }

  async function getAccessToken(): Promise<string> {
    const currentTime = now();
    if (tokenCache && currentTime < tokenCache.expiresAtMs - tokenExpirySkewMs) {
      return tokenCache.accessToken;
    }

    const tokenUrl = new URL(`${identityBaseUrl}/${encodeURIComponent(sharePoint.tenantId)}/oauth2/v2.0/token`);
    const response = await safeFetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: sharePoint.clientId,
        client_secret: sharePoint.clientSecret,
        scope: `${graphScopeBase}/.default`,
      }),
    }, "SharePoint request failed");

    if (!response.ok) {
      await readGraphError(response);
    }

    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new SharePointGraphError(502, "SharePoint token response was invalid");
    }
    const expiresInSeconds = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;

    tokenCache = {
      accessToken: payload.access_token,
      expiresAtMs: currentTime + Math.max(1, expiresInSeconds) * 1000,
    };
    return tokenCache.accessToken;
  }

  function assertAbsoluteHttpUrl(rawUrl: string, label: string, status: number, allowHttp: boolean): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SharePointGraphError(status, `${label} is invalid`);
    }

    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
      throw new SharePointGraphError(status, `${label} is invalid`);
    }
    return parsed.toString();
  }

  function childCollectionPath(folderId: string): string {
    return `${graphBase.pathname.replace(/\/$/, "")}/drives/${encodeURIComponent(sharePoint.driveId)}/items/${encodeURIComponent(folderId)}/children`;
  }

  function assertGraphNextLink(rawUrl: string, status: number, folderId: string): string {
    const nextLink = assertAbsoluteHttpUrl(rawUrl, "page token", status, allowHttpGraphUrls);
    const parsed = new URL(nextLink);
    const normalizedPath = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    const expectedPath = childCollectionPath(folderId);

    if (parsed.origin !== graphBase.origin) {
      throw new SharePointGraphError(status, "page token is invalid");
    }
    if (normalizedPath !== graphPathPrefix && !normalizedPath.startsWith(graphPathPrefix)) {
      throw new SharePointGraphError(status, "page token is invalid");
    }
    if (parsed.pathname !== expectedPath) {
      throw new SharePointGraphError(status, "page token is invalid");
    }

    return parsed.toString();
  }

  async function graphJson<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await getAccessToken();
    const response = await safeFetch(
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
        ? pathOrUrl
        : `${graphBaseUrl}${pathOrUrl}`,
      {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...init.headers,
        },
      },
      "SharePoint request failed",
    );
    if (!response.ok) {
      await readGraphError(response);
    }
    return await response.json() as T;
  }

  async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader != null) {
      const reported = Number(contentLengthHeader);
      if (Number.isFinite(reported) && reported > maxBytes) {
        throw new SharePointGraphError(400, `schematic JSON exceeds ${maxBytes} bytes`);
      }
    }

    const body = response.body;
    if (!body) {
      return "";
    }

    const reader = body.getReader();
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try { await reader.cancel(); } catch { void 0; /* ignore: cancel failure must not mask original error */ }
            throw new SharePointGraphError(400, `schematic JSON exceeds ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (err instanceof SharePointGraphError) {
        throw err;
      }
      try { await reader.cancel(); } catch { void 0; /* ignore: cancel failure must not mask original error */ }
      throw new SharePointGraphError(502, "SharePoint content response was invalid");
    }

    const buf = Buffer.concat(chunks);
    return buf.toString("utf8");
  }

  async function downloadGraphContent(path: string): Promise<string> {
    const accessToken = await getAccessToken();
    const initialUrl = `${graphBaseUrl}${path}`;
    const initialResponse = await safeFetch(initialUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      redirect: "manual",
    }, "SharePoint request failed");

    if (initialResponse.status >= 300 && initialResponse.status < 400) {
      const redirectLocation = initialResponse.headers.get("location");
      if (!redirectLocation) {
        throw new SharePointGraphError(502, "SharePoint content response was invalid");
      }

      let safeRedirectUrl: string;
      try {
        const parsedRedirect = new URL(redirectLocation, initialResponse.url || initialUrl);
        if (parsedRedirect.protocol !== "https:" && parsedRedirect.protocol !== "http:") {
          throw new Error("invalid redirect protocol");
        }
        safeRedirectUrl = parsedRedirect.toString();
      } catch {
        throw new SharePointGraphError(502, "SharePoint content redirect was invalid");
      }
      const redirectedResponse = await safeFetch(safeRedirectUrl, {
        method: "GET",
        headers: {},
        redirect: "manual",
      }, "SharePoint request failed");

      if (redirectedResponse.status >= 300 && redirectedResponse.status < 400) {
        throw new SharePointGraphError(502, "SharePoint content redirect was invalid");
      }
      if (!redirectedResponse.ok) {
        await readGraphError(redirectedResponse);
      }
      return await readBoundedText(redirectedResponse, schematicMaxJsonBytes);
    }

    if (!initialResponse.ok) {
      await readGraphError(initialResponse);
    }
    return await readBoundedText(initialResponse, schematicMaxJsonBytes);
  }

  async function fetchItem(itemId: string): Promise<RequiredGraphItemPayload> {
    const payload = await graphJson<GraphItemPayload>(
      `/drives/${encodeURIComponent(sharePoint.driveId)}/items/${encodeURIComponent(itemId)}?$select=${selectFields()}`,
    );
    const mapped = mapGraphItem(payload);
    return {
      ...payload,
      id: mapped.id,
      name: mapped.name,
    };
  }

  function assertDriveAndSite(raw: RequiredGraphItemPayload): void {
    const parentReference = raw.parentReference;
    if (
      (parentReference?.driveId && parentReference.driveId !== sharePoint.driveId)
      || (parentReference?.siteId && parentReference.siteId !== sharePoint.siteId)
    ) {
      throw new SharePointGraphError(403, "SharePoint item is outside the configured root");
    }
  }

  async function traceItemToRoot(itemId: string): Promise<ItemLineage> {
    const raw = await fetchItem(itemId);
    assertDriveAndSite(raw);
    const current = { item: mapGraphItem(raw), raw };
    const ancestors: SharePointGraphItem[] = [current.item];
    let cursor = raw;

    for (let depth = 0; depth < containmentMaxDepth; depth += 1) {
      if (cursor.id === sharePoint.rootFolderId) {
        return {
          current,
          breadcrumbs: ancestors.slice().reverse(),
        };
      }

      const parentId = typeof cursor.parentReference?.id === "string" ? cursor.parentReference.id : null;
      if (!parentId) {
        throw new SharePointGraphError(403, "SharePoint item is outside the configured root");
      }

      const parent = await fetchItem(parentId);
      assertDriveAndSite(parent);
      ancestors.push(mapGraphItem(parent));
      cursor = parent;
    }

    throw new SharePointGraphError(403, "SharePoint item is outside the configured root");
  }

  async function requireContainedItem(itemId: string): Promise<ContainedItem> {
    return (await traceItemToRoot(itemId)).current;
  }

  async function requireContainedFolder(folderId: string): Promise<ItemLineage> {
    const lineage = await traceItemToRoot(assertFolderId(folderId));
    if (lineage.current.item.type !== "folder") {
      throw new SharePointGraphError(400, "SharePoint target must be a folder");
    }
    return lineage;
  }

  async function requireContainedFile(fileId: string): Promise<ContainedItem> {
    const contained = await requireContainedItem(assertFileId(fileId));
    if (contained.item.type !== "file") {
      throw new SharePointGraphError(400, "SharePoint target must be a file");
    }
    if (!contained.item.name.toLowerCase().endsWith(".json")) {
      throw new SharePointGraphError(400, "SharePoint file must be a JSON file");
    }
    return contained;
  }

  return {
    async listFolderChildren(folderId, options = {}) {
      const pageSize = clampPageSize(options.pageSize);
      const lineage = folderId == null
        ? await requireContainedFolder(sharePoint.rootFolderId)
        : await requireContainedFolder(folderId);
      const pageToken = options.pageToken == null
        ? null
        : assertGraphNextLink(decodePageToken(options.pageToken), 400, lineage.current.item.id);
      const payload = pageToken == null
        ? await graphJson<GraphChildrenPayload>(
          `/drives/${encodeURIComponent(sharePoint.driveId)}/items/${encodeURIComponent(lineage.current.item.id)}/children`
          + `?$select=${selectFields()}&$top=${pageSize}`,
        )
        : await graphJson<GraphChildrenPayload>(pageToken);

      if (!Array.isArray(payload.value)) {
        throw new SharePointGraphError(502, "SharePoint returned an invalid children payload");
      }

      const items = payload.value.map((entry) => mapGraphItem(entry as GraphItemPayload));
      const nextLink = typeof payload["@odata.nextLink"] === "string"
        ? assertGraphNextLink(payload["@odata.nextLink"], 502, lineage.current.item.id)
        : null;

      return {
        folder: lineage.current.item,
        breadcrumbs: lineage.breadcrumbs,
        items,
        nextPageToken: nextLink ? encodePageToken(nextLink) : null,
      };
    },

    async uploadSchematic(folderId, fileName, schematic) {
      const targetFolderId = folderId == null ? sharePoint.rootFolderId : assertFolderId(folderId);
      const targetFolder = await requireContainedFolder(targetFolderId);
      const safeFileName = assertJsonFileName(fileName);
      const prepared = validateSchematicShape(schematic, schematicMaxJsonBytes);

      const uploaded = await graphJson<GraphItemPayload>(
        `/drives/${encodeURIComponent(sharePoint.driveId)}/items/${encodeURIComponent(targetFolder.current.item.id)}:`
        + `/${encodeURIComponent(safeFileName)}:/content?@microsoft.graph.conflictBehavior=replace`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: prepared.json,
        },
      );
      const item = mapGraphItem(uploaded);
      if (item.type !== "file") {
        throw new SharePointGraphError(502, "SharePoint upload did not return a file");
      }
      return (await requireContainedFile(item.id)).item;
    },

    async downloadSchematic(fileId) {
      const containedFile = await requireContainedFile(fileId);
      if (containedFile.item.size > schematicMaxJsonBytes) {
        throw new SharePointGraphError(400, `schematic JSON exceeds ${schematicMaxJsonBytes} bytes`);
      }

      const content = await downloadGraphContent(
        `/drives/${encodeURIComponent(sharePoint.driveId)}/items/${encodeURIComponent(containedFile.item.id)}/content`,
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw new SharePointGraphError(400, "SharePoint file did not contain valid JSON");
      }
      return validateSchematicShape(parsed, schematicMaxJsonBytes).data;
    },

    async resolveMetadata(itemId) {
      return (await requireContainedItem(assertSafeItemId(itemId, "item id"))).item;
    },
  };
}
