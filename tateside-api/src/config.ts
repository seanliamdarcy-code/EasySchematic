import { mkdirSync } from "node:fs";
import path from "node:path";

export interface ApiConfig {
  dataDir: string;
  dbPath: string;
  schematicRepositoryPath: string;
  schematicMaxJsonBytes: number;
  sharePointMaxUploadBytes: number;
  host: string;
  port: number;
  allowedOrigin: string;
  requireAccessIdentity: boolean;
  quoteImportMaxFileBytes: number;
  jetbuiltApiBaseUrl: string;
  jetbuiltIndexPath: string;
  jetbuiltIndexRefreshMs: number;
  quoteResearchCachePath: string;
  importNormalizationEnabled: boolean;
  libraryAuditEnabled: boolean;
  libraryDoctorEnabled: boolean;
  sharePoint: SharePointConfig | null;
}

export interface SharePointConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteId: string;
  driveId: string;
  rootFolderId: string;
  identityBaseUrl: string;
  graphBaseUrl: string;
}

const defaultDataDir =
  process.platform === "win32"
    ? path.resolve(".tateside-data")
    : "/var/lib/tateside-schematic";

function numberFromEnv(rawValue: string | undefined, fallback: number, label: string): number {
  const value = rawValue == null || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function integerFromEnv(rawValue: string | undefined, fallback: number, label: string, min: number): number {
  const value = numberFromEnv(rawValue, fallback, label);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function stringFromEnv(rawValue: string | undefined): string | null {
  if (rawValue == null) {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed ? trimmed : null;
}

function testOnlyUrlOverride(label: string, rawValue: string | undefined, fallback: string): string {
  const value = stringFromEnv(rawValue);
  if (value == null) {
    return fallback;
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${label} may be overridden only during local tests`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function getSharePointConfig(): SharePointConfig | null {
  const values = {
    MS_ENTRA_TENANT_ID: stringFromEnv(process.env.MS_ENTRA_TENANT_ID),
    MS_GRAPH_CLIENT_ID: stringFromEnv(process.env.MS_GRAPH_CLIENT_ID),
    MS_GRAPH_CLIENT_SECRET: stringFromEnv(process.env.MS_GRAPH_CLIENT_SECRET),
    TATESIDE_SHAREPOINT_SITE_ID: stringFromEnv(process.env.TATESIDE_SHAREPOINT_SITE_ID),
    TATESIDE_SHAREPOINT_DRIVE_ID: stringFromEnv(process.env.TATESIDE_SHAREPOINT_DRIVE_ID),
    TATESIDE_SHAREPOINT_ROOT_FOLDER_ID: stringFromEnv(process.env.TATESIDE_SHAREPOINT_ROOT_FOLDER_ID),
  };
  const presentKeys = Object.entries(values)
    .filter(([, value]) => value != null)
    .map(([key]) => key);

  if (presentKeys.length === 0) {
    return null;
  }

  const missingKeys = Object.entries(values)
    .filter(([, value]) => value == null)
    .map(([key]) => key);
  if (missingKeys.length > 0) {
    throw new Error(
      `Incomplete SharePoint configuration: missing ${missingKeys.join(", ")}. `
      + "Set all SharePoint environment variables or none of them.",
    );
  }

  return {
    tenantId: values.MS_ENTRA_TENANT_ID ?? "",
    clientId: values.MS_GRAPH_CLIENT_ID ?? "",
    clientSecret: values.MS_GRAPH_CLIENT_SECRET ?? "",
    siteId: values.TATESIDE_SHAREPOINT_SITE_ID ?? "",
    driveId: values.TATESIDE_SHAREPOINT_DRIVE_ID ?? "",
    rootFolderId: values.TATESIDE_SHAREPOINT_ROOT_FOLDER_ID ?? "",
    identityBaseUrl: testOnlyUrlOverride(
      "MS_ENTRA_BASE_URL",
      process.env.MS_ENTRA_BASE_URL,
      "https://login.microsoftonline.com",
    ),
    graphBaseUrl: testOnlyUrlOverride(
      "MS_GRAPH_BASE_URL",
      process.env.MS_GRAPH_BASE_URL,
      "https://graph.microsoft.com/v1.0",
    ),
  };
}

export function getConfig(): ApiConfig {
  const dataDir = process.env.TATESIDE_DATA_DIR || defaultDataDir;
  mkdirSync(dataDir, { recursive: true });

  return {
    dataDir,
    dbPath: process.env.TATESIDE_DB_PATH || path.join(dataDir, "tateside.db"),
    schematicRepositoryPath: process.env.TATESIDE_SCHEMATIC_REPOSITORY_PATH || path.join(dataDir, "schematic-repository"),
    schematicMaxJsonBytes: integerFromEnv(
      process.env.TATESIDE_SCHEMATIC_MAX_JSON_BYTES,
      10 * 1024 * 1024,
      "TATESIDE_SCHEMATIC_MAX_JSON_BYTES",
      1024,
    ),
    sharePointMaxUploadBytes: integerFromEnv(
      process.env.TATESIDE_SHAREPOINT_MAX_UPLOAD_BYTES,
      25 * 1024 * 1024,
      "TATESIDE_SHAREPOINT_MAX_UPLOAD_BYTES",
      1024,
    ),
    host: process.env.TATESIDE_API_HOST || "127.0.0.1",
    port: integerFromEnv(process.env.TATESIDE_API_PORT, 8788, "TATESIDE_API_PORT", 1),
    allowedOrigin: process.env.TATESIDE_ALLOWED_ORIGIN || "https://schematic.tateside.online",
    requireAccessIdentity: process.env.TATESIDE_REQUIRE_ACCESS_IDENTITY === "1",
    quoteImportMaxFileBytes: integerFromEnv(
      process.env.OPENAI_QUOTE_IMPORT_MAX_FILE_BYTES,
      15 * 1024 * 1024,
      "OPENAI_QUOTE_IMPORT_MAX_FILE_BYTES",
      1024,
    ),
    jetbuiltApiBaseUrl: process.env.JETBUILT_API_BASE_URL || "https://app.jetbuilt.com/api",
    jetbuiltIndexPath: process.env.JETBUILT_INDEX_PATH || path.join(dataDir, "jetbuilt-index.json"),
    jetbuiltIndexRefreshMs: integerFromEnv(
      process.env.JETBUILT_INDEX_REFRESH_MS,
      60 * 60 * 1000,
      "JETBUILT_INDEX_REFRESH_MS",
      1,
    ),
    quoteResearchCachePath: process.env.OPENAI_QUOTE_RESEARCH_CACHE_PATH || path.join(dataDir, "quote-research-cache.json"),
    importNormalizationEnabled: process.env.TATESIDE_IMPORT_NORMALIZATION_ENABLED === "1",
    libraryAuditEnabled: process.env.TATESIDE_LIBRARY_AUDIT_ENABLED === "1",
    libraryDoctorEnabled: process.env.TATESIDE_LIBRARY_DOCTOR_ENABLED === "1",
    sharePoint: getSharePointConfig(),
  };
}
