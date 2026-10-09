import type { DatabaseSync } from "node:sqlite";
import {
  fetchJetbuiltPagedCollection,
  jetbuiltGetJson,
  type JetbuiltClientOptions,
} from "./jetbuilt.js";
import {
  completeSyncRun,
  createSyncRun,
  failSyncRun,
  incrementSyncRequestCount,
  ingestHistoryProject,
} from "./jetbuiltHistoryStore.js";
import { normalizeJetbuiltStage } from "./jetbuiltHistoryCohorts.js";

export interface JetbuiltHistoryBounds {
  projectIds?: string[];
  minCreatedAt?: string;
  maxCreatedAt?: string;
  minUpdatedAt?: string;
  maxUpdatedAt?: string;
  maxProjectCount?: number;
}

export interface JetbuiltHistorySampleProject {
  id: string;
  stage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export function selectStratifiedHistoryProjectIds(
  projects: readonly JetbuiltHistorySampleProject[],
  quotas: Record<string, number>,
  maxProjectCount = 100,
): string[] {
  if (!Number.isInteger(maxProjectCount) || maxProjectCount < 1 || maxProjectCount > 100) throw new Error("maxProjectCount must be an integer from 1 to 100");
  const selected: string[] = [];
  for (const stage of Object.keys(quotas).sort()) {
    const quota = quotas[stage];
    if (!Number.isInteger(quota) || quota < 0) throw new Error(`quota for ${stage} must be a non-negative integer`);
    const candidates = projects
      .filter((project) => normalizeJetbuiltStage(project.stage) === normalizeJetbuiltStage(stage))
      .sort((left, right) => `${left.updatedAt ?? left.createdAt ?? ""}:${left.id}`.localeCompare(`${right.updatedAt ?? right.createdAt ?? ""}:${right.id}`));
    if (quota === 0 || candidates.length === 0) continue;
    if (quota >= candidates.length) selected.push(...candidates.map((project) => project.id));
    else if (quota === 1) selected.push(candidates[Math.floor(candidates.length / 2)].id);
    else selected.push(...Array.from({ length: quota }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / (quota - 1))].id));
  }
  const unique = [...new Set(selected)];
  if (unique.length > maxProjectCount) throw new Error("stratified sample exceeds maxProjectCount");
  return unique;
}

function validateDate(value: string | undefined, name: string): void {
  if (value && !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO-compatible date`);
}

export function validateHistoryBounds(bounds: JetbuiltHistoryBounds): JetbuiltHistoryBounds {
  const projectIds = [...new Set((bounds.projectIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const hasDateBound = Boolean(bounds.minCreatedAt || bounds.maxCreatedAt || bounds.minUpdatedAt || bounds.maxUpdatedAt);
  if (projectIds.length === 0 && !hasDateBound && bounds.maxProjectCount == null) throw new Error("At least one project ID, created/updated date bound, or maximum project count is required");
  if (bounds.maxProjectCount != null && (!Number.isInteger(bounds.maxProjectCount) || bounds.maxProjectCount < 1 || bounds.maxProjectCount > 100)) {
    throw new Error("maxProjectCount must be an integer from 1 to 100");
  }
  if (projectIds.length > (bounds.maxProjectCount ?? 100)) throw new Error("projectIds exceeds maxProjectCount");
  validateDate(bounds.minCreatedAt, "minCreatedAt");
  validateDate(bounds.maxCreatedAt, "maxCreatedAt");
  validateDate(bounds.minUpdatedAt, "minUpdatedAt");
  validateDate(bounds.maxUpdatedAt, "maxUpdatedAt");
  return { ...bounds, projectIds, maxProjectCount: bounds.maxProjectCount ?? (projectIds.length === 0 ? 25 : undefined) };
}

function projectId(project: unknown): string | null {
  if (!project || typeof project !== "object") return null;
  const raw = (project as Record<string, unknown>).id ?? (project as Record<string, unknown>).project_id;
  return raw == null ? null : String(raw);
}

export async function syncJetbuiltHistory(
  db: DatabaseSync,
  rawBounds: JetbuiltHistoryBounds,
  clientOptions: JetbuiltClientOptions,
): Promise<{ syncRunId: number; projectCount: number }> {
  const bounds = validateHistoryBounds(rawBounds);
  const mode = bounds.projectIds?.length ? "project_ids" : bounds.minCreatedAt || bounds.maxCreatedAt ? "created_range" : bounds.minUpdatedAt || bounds.maxUpdatedAt ? "updated_range" : "max_count";
  const syncRunId = createSyncRun(db, mode, bounds);
  const baseUrl = (clientOptions.baseUrl ?? "https://app.jetbuilt.com/api").replace(/\/$/, "");
  const options: JetbuiltClientOptions = {
    ...clientOptions,
    onRequest: () => {
      incrementSyncRequestCount(db, syncRunId);
      clientOptions.onRequest?.();
    },
  };

  try {
    if (!clientOptions.apiKey.trim()) throw new Error("JETBUILT_API_KEY is not configured");
    let ids = bounds.projectIds ?? [];
    if (ids.length === 0) {
      const url = new URL(`${baseUrl}/projects`);
      if (bounds.minCreatedAt) url.searchParams.set("min_created_at", bounds.minCreatedAt);
      if (bounds.maxCreatedAt) url.searchParams.set("max_created_at", bounds.maxCreatedAt);
      if (bounds.minUpdatedAt) url.searchParams.set("min_updated_at", bounds.minUpdatedAt);
      if (bounds.maxUpdatedAt) url.searchParams.set("max_updated_at", bounds.maxUpdatedAt);
      const projects = await fetchJetbuiltPagedCollection(url.toString(), options, bounds.maxProjectCount ?? 25);
      ids = projects.map(projectId).filter((id): id is string => id !== null);
    }

    let highWaterMark: string | null = null;
    for (const id of ids) {
      const encoded = encodeURIComponent(id);
      const project = await jetbuiltGetJson<Record<string, unknown>>(`${baseUrl}/projects/${encoded}`, options);
      const rooms = await fetchJetbuiltPagedCollection(`${baseUrl}/projects/${encoded}/rooms`, options);
      const systems = await fetchJetbuiltPagedCollection(`${baseUrl}/projects/${encoded}/systems`, options);
      const items = await fetchJetbuiltPagedCollection(`${baseUrl}/projects/${encoded}/items`, options);
      const versions = await fetchJetbuiltPagedCollection(`${baseUrl}/projects/${encoded}/versions`, options);
      ingestHistoryProject(db, syncRunId, {
        project,
        rooms: rooms as Record<string, unknown>[],
        systems: systems as Record<string, unknown>[],
        items: items as Record<string, unknown>[],
        versions: versions as Record<string, unknown>[],
      });
      const updatedAt = project.updated_at == null ? null : String(project.updated_at);
      if (updatedAt && (!highWaterMark || updatedAt > highWaterMark)) highWaterMark = updatedAt;
    }
    completeSyncRun(db, syncRunId, highWaterMark);
    return { syncRunId, projectCount: ids.length };
  } catch (error) {
    failSyncRun(db, syncRunId, error);
    throw error;
  }
}
