import type { AiDeviceGenerationMetadata, DeviceTemplate } from "./types.js";

export type LibraryMatchStatus = "already_in_library" | "possible_match" | "missing";

export type QuoteImportReasoningEffort = "low" | "medium" | "high";

export interface ExtractedQuoteDevice {
  manufacturer: string | null;
  model: string;
  description: string | null;
  quantity: number | null;
  sourceLineText: string | null;
  normalizedLookupKey: string;
  commercialSku?: string | null;
  sourceKind?: "standalone" | "bundle_component";
  bundleOrigin?: "known_catalogue" | "suggested" | "manual" | null;
  bundleId?: string | null;
  bundleLabel?: string | null;
  bundleQuantity?: number | null;
  componentQuantityPerBundle?: number | null;
  room?: string | null;
  system?: string | null;
  /** Stable identity for a single procurement/import line. Never use this for template identity. */
  importItemId?: string | null;
  /** Links a schematic-facing child to its procurement bundle parent. */
  bundleGroupId?: string | null;
}

export interface QuoteImportCandidateMatch {
  id: string;
  label: string;
  manufacturer: string | null;
  modelNumber: string | null;
  normalizedLookupKey: string;
  matchReason: string;
}

export interface QuoteImportResultItem extends ExtractedQuoteDevice {
  status: LibraryMatchStatus;
  exactMatch: QuoteImportCandidateMatch | null;
  possibleMatches: QuoteImportCandidateMatch[];
  portReuseCandidates: QuoteImportCandidateMatch[];
}

export type PossibleMatchDecision =
  | { kind: "use_library_match"; templateId: string }
  | { kind: "research_missing" };

export function resolveSelectedPossibleMatch(
  item: QuoteImportResultItem,
  decision: PossibleMatchDecision | undefined,
): QuoteImportCandidateMatch | null {
  if (item.status !== "possible_match" || decision?.kind !== "use_library_match") return null;
  return item.possibleMatches.find((match) => match.id === decision.templateId) ?? null;
}

export type BundleResolutionState = "known_catalogue" | "suggested" | "unresolved" | "manual";

/**
 * A commercial/procurement parent from Jetbuilt. It is deliberately not a
 * DeviceTemplate: only its child components are allowed into the library.
 */
export interface QuoteImportBundleGroup {
  id: string;
  manufacturer: string | null;
  commercialSku: string;
  label: string;
  description: string | null;
  sourceLineText: string | null;
  quantity: number | null;
  room: string | null;
  system: string | null;
  resolution: BundleResolutionState;
  accepted: boolean;
  bundleId: string | null;
  warnings: string[];
  components: QuoteImportResultItem[];
}

export interface ProductBundlePreviewRequest {
  group: Omit<QuoteImportBundleGroup, "components">;
  components: ProductBundleComponent[];
}

export interface ProductBundlePreviewResponse {
  components: QuoteImportResultItem[];
}

export interface QuoteImportExtractionResponse {
  fileName: string;
  fileType: string;
  extractedCount: number;
  extractionModel: string;
  extractionReasoningEffort: QuoteImportReasoningEffort;
  results: QuoteImportResultItem[];
  bundleGroups?: QuoteImportBundleGroup[];
  warnings: string[];
}

export interface ProductBundleComponent {
  manufacturer: string;
  model: string;
  quantityPerBundle: number;
  schematicRelevant: boolean;
}

export interface ProductBundleDefinition {
  id: string;
  manufacturer: string;
  sku: string;
  label: string;
  aliases?: string[];
  source: "manual" | "ai_reviewed" | "manufacturer";
  components: ProductBundleComponent[];
  createdAt?: string;
  updatedAt?: string;
}

export interface QuoteImportDraftValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface QuoteImportDraftReview {
  extractedDevice: ExtractedQuoteDevice;
  template: DeviceTemplate | null;
  metadata: AiDeviceGenerationMetadata | null;
  draftSource: "ai_research" | "library_port_copy";
  validation: QuoteImportDraftValidation;
  reviewStatus: "draft_ready" | "manual_review_required";
  error: string | null;
  portSummary: string[];
}

export interface QuoteImportResearchResponse {
  fileName: string;
  results: QuoteImportDraftReview[];
  warnings: string[];
}

export type QuoteImportResearchJobStatus = "queued" | "running" | "complete" | "error";

export interface QuoteImportResearchJobResponse {
  jobId: string;
  status: QuoteImportResearchJobStatus;
  fileName: string;
  total: number;
  completed: number;
  currentLabel: string | null;
  result: QuoteImportResearchResponse | null;
  error: string | null;
}

export interface JetbuiltProjectSearchResult {
  id: string;
  customId: string | null;
  name: string;
  clientId: string | null;
  clientName: string | null;
  stage: string | null;
  active: boolean | null;
  updatedAt: string | null;
  itemCount: number | null;
  currency: string | null;
  total: number | null;
}

export interface JetbuiltClientSearchResult {
  id: string;
  companyName: string;
  primaryContactName: string | null;
  updatedAt: string | null;
  projectCount: number;
}

export interface JetbuiltIndexStatus {
  syncedAt: string | null;
  refreshing: boolean;
  projectCount: number;
  clientCount: number;
  lastError: string | null;
}
