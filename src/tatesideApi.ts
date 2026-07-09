import type { DeviceTemplate, SchematicFile } from "./types";
import type {
  ImportNormalizationResolveRequest,
  ImportNormalizationResolution,
  ImportNormalizationRule,
} from "./importNormalization";
import type {
  ExtractedQuoteDevice,
  JetbuiltClientSearchResult,
  JetbuiltIndexStatus,
  JetbuiltProjectSearchResult,
  ProductBundleDefinition,
  ProductBundlePreviewRequest,
  ProductBundlePreviewResponse,
  QuoteImportResearchJobResponse,
  QuoteImportExtractionResponse,
  QuoteImportResearchResponse,
} from "./quoteImportTypes";

const DEFAULT_TATESIDE_API_URL = "/api/tateside";

const TATESIDE_API_URL = (
  import.meta.env?.VITE_TATESIDE_API_URL ?? DEFAULT_TATESIDE_API_URL
).replace(/\/$/, "");

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface SharePointItem {
  id: string;
  name: string;
  type: "folder" | "file";
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
}

export interface SharePointListing {
  folderId: string | null;
  folderName: string;
  parentId: string | null;
  breadcrumbs: { id: string | null; name: string }[];
  items: SharePointItem[];
}

export interface SharePointSavedFile {
  id: string;
  name: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
}

export interface TatesideBulkEditResultItem {
  id: string;
  beforeLabel: string;
  afterLabel: string;
  beforeManufacturer: string | null;
  afterManufacturer: string | null;
  status: "updated" | "unchanged" | "conflict" | "invalid";
  reason?: string;
  conflictWithId?: string;
  conflictWithLabel?: string;
}

export interface TatesideBulkEditResult {
  templates: DeviceTemplate[];
  results: TatesideBulkEditResultItem[];
}

export interface TatesideBulkDeleteResultItem {
  id: string;
  label: string;
  manufacturer: string | null;
  status: "deleted";
}

export interface TatesideBulkDeleteResult {
  results: TatesideBulkDeleteResultItem[];
}

export interface TatesideSchematicSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  currentVersionSequence: number;
  currentHash: string;
  currentSizeBytes: number;
  createdByEmail: string | null;
  updatedByEmail: string | null;
}

export interface TatesideSchematicVersionSummary {
  sequence: number;
  title: string;
  contentHash: string;
  sizeBytes: number;
  source: string | null;
  createdAt: string;
  createdByEmail: string | null;
  isCurrent: boolean;
}

export interface TatesideSchematicDocument {
  schematic: TatesideSchematicSummary;
  version: TatesideSchematicVersionSummary;
  data: SchematicFile;
}

export class TatesideApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TatesideApiError";
    this.status = status;
  }
}

async function requestJson<T>(
  path: string,
  options: { method?: HttpMethod; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${TATESIDE_API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const fallback =
      res.status === 404
        ? "TateSide API endpoint is not available yet"
        : `TateSide API request failed (${res.status})`;
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    const text = data?.error ?? (await res.text().catch(() => ""));
    throw new TatesideApiError(text || fallback, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTatesideDeviceTemplates(): Promise<DeviceTemplate[]> {
  return requestJson<DeviceTemplate[]>("/devices/templates");
}

export async function saveTatesideDeviceTemplates(
  templates: Omit<DeviceTemplate, "id" | "version">[],
  options: { note?: string; source?: string } = {},
): Promise<{ templates: DeviceTemplate[] }> {
  return requestJson("/devices/templates", {
    method: "POST",
    body: {
      templates,
      ...(options.note ? { note: options.note } : {}),
      ...(options.source ? { source: options.source } : {}),
    },
  });
}

export async function listImportNormalizationRules(): Promise<ImportNormalizationRule[]> {
  const response = await requestJson<{ rules: ImportNormalizationRule[] }>("/import-normalization-rules");
  return response.rules;
}

export async function createImportNormalizationRule(
  rule: Omit<ImportNormalizationRule, "id" | "normalizedRawValue" | "normalizedManufacturer" | "normalizedModelNumber" | "createdAt" | "createdByEmail" | "updatedAt" | "updatedByEmail" | "source">,
): Promise<ImportNormalizationRule> {
  const response = await requestJson<{ rule: ImportNormalizationRule }>("/import-normalization-rules", {
    method: "POST",
    body: rule,
  });
  return response.rule;
}

export async function updateImportNormalizationRule(
  ruleId: string,
  rule: Partial<Omit<ImportNormalizationRule, "id" | "normalizedRawValue" | "normalizedManufacturer" | "normalizedModelNumber" | "createdAt" | "createdByEmail" | "updatedAt" | "updatedByEmail" | "source">>,
): Promise<ImportNormalizationRule> {
  const response = await requestJson<{ rule: ImportNormalizationRule }>(`/import-normalization-rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    body: rule,
  });
  return response.rule;
}

export async function deleteImportNormalizationRule(ruleId: string): Promise<void> {
  await requestJson(`/import-normalization-rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
}

export async function resolveImportNormalizationRequest(
  request: ImportNormalizationResolveRequest,
): Promise<ImportNormalizationResolution> {
  return requestJson<ImportNormalizationResolution>("/import-normalization-rules/resolve", {
    method: "POST",
    body: request,
  });
}

export async function updateTatesideDeviceTemplate(
  templateId: string,
  template: Omit<DeviceTemplate, "id" | "version">,
  options: { note?: string; source?: string } = {},
): Promise<{ template: DeviceTemplate }> {
  return requestJson(`/devices/templates/${encodeURIComponent(templateId)}`, {
    method: "PUT",
    body: {
      template,
      ...(options.note ? { note: options.note } : {}),
      ...(options.source ? { source: options.source } : {}),
    },
  });
}

export async function deleteTatesideDeviceTemplate(
  templateId: string,
  options: { note?: string } = {},
): Promise<void> {
  await requestJson(`/devices/templates/${encodeURIComponent(templateId)}`, {
    method: "DELETE",
    body: options.note ? { note: options.note } : {},
  });
}

export async function bulkEditTatesideDeviceTemplates(
  input: {
    templateIds: string[];
    setManufacturer?: string;
    setCategory?: string;
    removeLabelPrefix?: string;
    findLabelText?: string;
    replaceLabelText?: string;
    note?: string;
    source?: string;
    preview?: boolean;
  },
): Promise<TatesideBulkEditResult> {
  return requestJson<TatesideBulkEditResult>("/devices/templates/bulk-edit", {
    method: "POST",
    body: {
      templateIds: input.templateIds,
      ...(input.setManufacturer !== undefined ? { setManufacturer: input.setManufacturer } : {}),
      ...(input.setCategory !== undefined ? { setCategory: input.setCategory } : {}),
      ...(input.removeLabelPrefix ? { removeLabelPrefix: input.removeLabelPrefix } : {}),
      ...(input.findLabelText ? { findLabelText: input.findLabelText, replaceLabelText: input.replaceLabelText ?? "" } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.preview ? { preview: true } : {}),
    },
  });
}

export async function bulkDeleteTatesideDeviceTemplates(
  input: {
    templateIds: string[];
    note?: string;
    source?: string;
  },
): Promise<TatesideBulkDeleteResult> {
  return requestJson<TatesideBulkDeleteResult>("/devices/templates/bulk-delete", {
    method: "POST",
    body: {
      templateIds: input.templateIds,
      ...(input.note ? { note: input.note } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
  });
}

export async function listSharePointFolder(folderId?: string | null): Promise<SharePointListing> {
  const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
  return requestJson<SharePointListing>(`/sharepoint/children${query}`);
}

export async function saveSchematicToSharePoint(
  folderId: string | null,
  fileName: string,
  data: unknown,
): Promise<SharePointSavedFile> {
  return requestJson<SharePointSavedFile>("/sharepoint/schematics", {
    method: "PUT",
    body: { folderId, fileName, data },
  });
}

export async function loadSchematicFromSharePoint(fileId: string): Promise<unknown> {
  return requestJson<unknown>(`/sharepoint/schematics/${encodeURIComponent(fileId)}`);
}

export async function publishPdfToSharePoint(
  folderId: string | null,
  fileName: string,
  data: Blob | ArrayBuffer,
): Promise<SharePointSavedFile> {
  const query = new URLSearchParams({ fileName });
  if (folderId) {
    query.set("folderId", folderId);
  }

  const body = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
  const res = await fetch(`${TATESIDE_API_URL}/sharepoint/pdfs?${query.toString()}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
    },
    credentials: "include",
    body,
  });

  if (!res.ok) {
    const fallback =
      res.status === 404
        ? "TateSide API endpoint is not available yet"
        : `TateSide API request failed (${res.status})`;
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new TatesideApiError(data?.error || fallback, res.status);
  }

  return res.json() as Promise<SharePointSavedFile>;
}

export async function createTatesideSchematic(
  data: SchematicFile,
  options: { source?: string } = {},
): Promise<TatesideSchematicDocument> {
  return requestJson<TatesideSchematicDocument>("/schematics", {
    method: "POST",
    body: {
      data,
      ...(options.source ? { source: options.source } : {}),
    },
  });
}

export async function saveTatesideSchematic(
  id: string,
  data: SchematicFile,
  options: { source?: string } = {},
): Promise<TatesideSchematicDocument & { createdNewVersion: boolean }> {
  return requestJson<TatesideSchematicDocument & { createdNewVersion: boolean }>(`/schematics/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: {
      data,
      ...(options.source ? { source: options.source } : {}),
    },
  });
}

export async function importDevicesFromQuote(file: File): Promise<QuoteImportExtractionResponse> {
  const res = await fetch(`${TATESIDE_API_URL}/quote-import/extract`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/pdf",
      "X-Tateside-Upload-Filename": encodeURIComponent(file.name),
    },
    credentials: "include",
    body: file,
  });

  if (!res.ok) {
    const fallback =
      res.status === 404
        ? "TateSide quote import endpoint is not available yet"
        : `TateSide API request failed (${res.status})`;
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new TatesideApiError(data?.error || fallback, res.status);
  }

  return res.json() as Promise<QuoteImportExtractionResponse>;
}

export async function searchJetbuiltProjects(query: string): Promise<JetbuiltProjectSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await requestJson<{ projects: JetbuiltProjectSearchResult[] }>(`/jetbuilt/projects?query=${encodeURIComponent(trimmed)}`);
  return response.projects;
}

export async function searchJetbuiltClients(query: string): Promise<JetbuiltClientSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await requestJson<{ clients: JetbuiltClientSearchResult[] }>(`/jetbuilt/clients?query=${encodeURIComponent(trimmed)}`);
  return response.clients;
}

export async function listJetbuiltProjectsForClient(clientId: string): Promise<JetbuiltProjectSearchResult[]> {
  const response = await requestJson<{ projects: JetbuiltProjectSearchResult[] }>(`/jetbuilt/clients/${encodeURIComponent(clientId)}/projects`);
  return response.projects;
}

export async function fetchJetbuiltIndexStatus(): Promise<JetbuiltIndexStatus> {
  return requestJson<JetbuiltIndexStatus>("/jetbuilt/status");
}

export async function importDevicesFromJetbuiltProject(projectId: string): Promise<QuoteImportExtractionResponse> {
  return requestJson<QuoteImportExtractionResponse>("/jetbuilt/import", {
    method: "POST",
    body: { projectId },
  });
}

export async function listProductBundles(): Promise<ProductBundleDefinition[]> {
  const response = await requestJson<{ bundles: ProductBundleDefinition[] }>("/product-bundles");
  return response.bundles;
}

export async function saveProductBundleDefinition(bundle: ProductBundleDefinition): Promise<ProductBundleDefinition> {
  const response = await requestJson<{ bundle: ProductBundleDefinition }>("/product-bundles", {
    method: "POST",
    body: bundle,
  });
  return response.bundle;
}

export async function previewProductBundleDefinition(request: ProductBundlePreviewRequest): Promise<ProductBundlePreviewResponse> {
  return requestJson<ProductBundlePreviewResponse>("/product-bundles/preview", {
    method: "POST",
    body: request,
  });
}

export async function resolveProductBundleDefinition(manufacturer: string, sku: string): Promise<ProductBundleDefinition | null> {
  const query = new URLSearchParams({ manufacturer, sku });
  const response = await requestJson<{ bundle: ProductBundleDefinition | null }>(`/product-bundles/resolve?${query.toString()}`);
  return response.bundle;
}

export async function researchQuoteDevices(
  fileName: string,
  devices: ExtractedQuoteDevice[],
  options: {
    forceEscalation?: boolean;
    onProgress?: (job: QuoteImportResearchJobResponse) => void;
  } = {},
): Promise<QuoteImportResearchResponse> {
  const startResponse = await requestJson<QuoteImportResearchJobResponse>("/quote-import/research", {
    method: "POST",
    body: {
      fileName,
      devices,
      ...(options.forceEscalation ? { forceEscalation: true } : {}),
    },
  });

  options.onProgress?.(startResponse);

  if (startResponse.status === "complete" && startResponse.result) {
    return startResponse.result;
  }

  let jobResponse = startResponse;
  const startedAt = Date.now();
  const maxWaitMs = 30 * 60 * 1000;

  while (jobResponse.status === "queued" || jobResponse.status === "running") {
    if (Date.now() - startedAt > maxWaitMs) {
      throw new TatesideApiError("Quote research is still running. Please try again in a moment.", 504);
    }

    await sleep(2000);
    jobResponse = await requestJson<QuoteImportResearchJobResponse>(`/quote-import/research/${encodeURIComponent(jobResponse.jobId)}`);
    options.onProgress?.(jobResponse);
  }

  if (jobResponse.status === "complete" && jobResponse.result) {
    return jobResponse.result;
  }

  throw new TatesideApiError(jobResponse.error || "Missing-device research failed", 500);
}

// ─── Library Doctor review queue (read/review only — no apply path) ───────────

export type LibraryDoctorProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "needs-manual-review"
  | "superseded";

export type LibraryDoctorConfidence = "low" | "medium" | "high";
export type LibraryDoctorRisk = "low" | "medium" | "high";
export type LibraryDoctorProposalType =
  | "field-value-change"
  | "taxonomy-classification"
  | "taxonomy-registry-change"
  | "alias-normalization"
  | "completeness-fill"
  | "other";

export type LibraryDoctorGenerationSource =
  | "alias-registry"
  | "library-audit"
  | "taxonomy-preview";

export interface LibraryDoctorEvidenceRef {
  type: string;
  url?: string;
  title?: string;
  excerpt?: string;
  note?: string;
  capturedAt?: string;
}

export interface LibraryDoctorProposalPreview {
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  readOnly: true;
  arrayDiff?: {
    added: unknown[];
    removed: unknown[];
  };
}

export interface LibraryDoctorProposal {
  id: string;
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  sourceIssueCode: string | null;
  sourceIssueGroup: string | null;
  sourceCurrentValue: unknown;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  proposalType: LibraryDoctorProposalType;
  confidence: LibraryDoctorConfidence;
  risk: LibraryDoctorRisk;
  evidenceRefs: LibraryDoctorEvidenceRef[];
  rationale: string | null;
  status: LibraryDoctorProposalStatus;
  createdAt: string;
  createdBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  supersedesProposalId: string | null;
  generationKey: string | null;
  preview: LibraryDoctorProposalPreview;
}

export interface LibraryDoctorProposalEvent {
  id: string;
  proposalId: string;
  oldStatus: LibraryDoctorProposalStatus | null;
  newStatus: LibraryDoctorProposalStatus;
  reviewer: string | null;
  reviewNote: string | null;
  eventType: "created" | "reviewed" | "superseded";
  details: Record<string, unknown>;
  createdAt: string;
}

export interface LibraryDoctorProposalCandidate {
  candidateKey: string;
  templateId: string;
  manufacturer: string | null;
  modelNumber: string | null;
  source: LibraryDoctorGenerationSource;
  sourceIssueCode: string | null;
  sourceIssueGroup: string | null;
  sourceCurrentValue: unknown;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  proposalType: LibraryDoctorProposalType;
  confidence: LibraryDoctorConfidence;
  risk: LibraryDoctorRisk;
  evidenceRefs: LibraryDoctorEvidenceRef[];
  rationale: string;
  readOnly: true;
}

export interface LibraryDoctorGenerationScope {
  templateIds?: string[];
  manufacturer?: string;
  issueCodes?: string[];
  fields?: string[];
  maxCandidates?: number;
}

export interface LibraryDoctorPreviewResult {
  readOnly: true;
  templatesScanned: number;
  candidates: LibraryDoctorProposalCandidate[];
  skipped: {
    highRisk: number;
    ambiguous: number;
    duplicateExisting: number;
  };
}

export interface LibraryDoctorEnqueueResult {
  requested: number;
  created: number;
  alreadyExisting: number;
  staleOrMissing: number;
  rejectedHighRisk: number;
  proposalIds: string[];
  existing: Array<{ candidateKey: string; proposalId: string; status: string }>;
  createdProposals: LibraryDoctorProposal[];
}

export interface LibraryDoctorProposalFilters {
  status?: string;
  manufacturer?: string;
  templateId?: string;
  field?: string;
  proposalType?: string;
  confidence?: string;
  risk?: string;
  sourceIssueCode?: string;
}

/** Review-queue status only. Accepted does not apply the proposal to a template. */
export type LibraryDoctorReviewActionStatus =
  | "accepted"
  | "rejected"
  | "needs-manual-review"
  | "pending";

export async function previewLibraryDoctorGeneration(
  scope: LibraryDoctorGenerationScope,
): Promise<LibraryDoctorPreviewResult> {
  return requestJson<LibraryDoctorPreviewResult>("/library-doctor/generation/preview", {
    method: "POST",
    body: scope,
  });
}

export async function enqueueLibraryDoctorCandidates(
  candidateKeys: string[],
): Promise<LibraryDoctorEnqueueResult> {
  return requestJson<LibraryDoctorEnqueueResult>("/library-doctor/generation/enqueue", {
    method: "POST",
    body: { candidateKeys },
  });
}

export async function listLibraryDoctorProposals(
  filters: LibraryDoctorProposalFilters = {},
): Promise<LibraryDoctorProposal[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && value !== "") query.set(key, value);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await requestJson<{ proposals: LibraryDoctorProposal[] }>(
    `/library-doctor/proposals${suffix}`,
  );
  return response.proposals;
}

export async function getLibraryDoctorProposal(proposalId: string): Promise<LibraryDoctorProposal> {
  const response = await requestJson<{ proposal: LibraryDoctorProposal }>(
    `/library-doctor/proposals/${encodeURIComponent(proposalId)}`,
  );
  return response.proposal;
}

export async function reviewLibraryDoctorProposal(
  proposalId: string,
  input: { status: LibraryDoctorReviewActionStatus; reviewNote?: string },
): Promise<LibraryDoctorProposal> {
  const response = await requestJson<{ proposal: LibraryDoctorProposal }>(
    `/library-doctor/proposals/${encodeURIComponent(proposalId)}/review`,
    {
      method: "POST",
      body: {
        status: input.status,
        ...(input.reviewNote != null && input.reviewNote !== ""
          ? { reviewNote: input.reviewNote }
          : {}),
      },
    },
  );
  return response.proposal;
}

export async function getLibraryDoctorProposalHistory(
  proposalId: string,
): Promise<LibraryDoctorProposalEvent[]> {
  const response = await requestJson<{ history: LibraryDoctorProposalEvent[] }>(
    `/library-doctor/proposals/${encodeURIComponent(proposalId)}/history`,
  );
  return response.history;
}
