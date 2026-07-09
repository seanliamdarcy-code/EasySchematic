import type {
  LibraryDoctorEnqueueResult,
  LibraryDoctorProposal,
  LibraryDoctorProposalStatus,
  LibraryDoctorReviewActionStatus,
} from "./tatesideApi";
import { TatesideApiError } from "./tatesideApi";

/** Display helper — never used to apply values to templates. */
export function formatLibraryDoctorValue(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function libraryDoctorStatusLabel(status: LibraryDoctorProposalStatus): string {
  switch (status) {
    case "needs-manual-review":
      return "Needs manual review";
    case "accepted":
      return "Accepted (queue only)";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

/**
 * Actions available for a proposal in the review UI.
 * There is never an "apply" action — accepted means approved in the queue only.
 */
export function availableLibraryDoctorReviewActions(
  status: LibraryDoctorProposalStatus,
): LibraryDoctorReviewActionStatus[] {
  if (status === "pending") {
    return ["accepted", "rejected", "needs-manual-review"];
  }
  if (status === "needs-manual-review") {
    return ["accepted", "rejected", "pending"];
  }
  return [];
}

export function libraryDoctorReviewActionLabel(action: LibraryDoctorReviewActionStatus): string {
  switch (action) {
    case "accepted":
      return "Accept (queue only)";
    case "rejected":
      return "Reject";
    case "needs-manual-review":
      return "Needs manual review";
    case "pending":
      return "Return to pending";
    default:
      return action;
  }
}

/** Safety: UI must never expose an apply/write-template action. */
export function libraryDoctorUiHasApplyAction(): false {
  return false;
}

export function summarizeProposalIdentity(proposal: Pick<LibraryDoctorProposal, "manufacturer" | "modelNumber" | "templateId">): string {
  const parts = [proposal.manufacturer, proposal.modelNumber].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return proposal.templateId;
}

export function parseCommaSeparatedList(raw: string): string[] | undefined {
  const items = raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Body for generation enqueue — candidateKeys only; never proposed values. */
export function buildLibraryDoctorEnqueueBody(candidateKeys: string[]): { candidateKeys: string[] } {
  return { candidateKeys: [...candidateKeys] };
}

export type LibraryDoctorFeatureArea = "queue" | "generation";

/**
 * Classify feature-gate / availability errors without treating 404 as catastrophic.
 * Queue: TATESIDE_LIBRARY_DOCTOR_ENABLED=1
 * Generation: both library doctor + generation flags.
 */
export function classifyLibraryDoctorFeatureError(
  err: unknown,
  area: LibraryDoctorFeatureArea,
): { kind: "disabled" | "not-found" | "other"; message: string } {
  if (err instanceof TatesideApiError && err.status === 404) {
    const text = err.message || "";
    const looksDisabled =
      /not enabled/i.test(text)
      || /Library Doctor/i.test(text)
      || /generation/i.test(text)
      || /not available/i.test(text);
    if (looksDisabled || text === "" || /endpoint is not available/i.test(text)) {
      return {
        kind: "disabled",
        message:
          area === "generation"
            ? "Candidate generation is not enabled on this TateSide API. Review Queue may still work if TATESIDE_LIBRARY_DOCTOR_ENABLED=1. Generation also needs TATESIDE_LIBRARY_DOCTOR_GENERATION_ENABLED=1."
            : "Library Doctor review queue is not enabled on this TateSide API (requires TATESIDE_LIBRARY_DOCTOR_ENABLED=1).",
      };
    }
    return {
      kind: "not-found",
      message: text || "Requested Library Doctor resource was not found.",
    };
  }
  if (err instanceof Error) {
    return { kind: "other", message: err.message };
  }
  return { kind: "other", message: "Unexpected error talking to Library Doctor API." };
}

export function formatLibraryDoctorEnqueueSummary(result: LibraryDoctorEnqueueResult): string {
  return (
    `Created: ${result.created} · Already existing: ${result.alreadyExisting} · ` +
    `Stale/missing: ${result.staleOrMissing} · Rejected high-risk: ${result.rejectedHighRisk}`
  );
}

export function hasMeaningfulLibraryDoctorGenerationScope(input: {
  manufacturer?: string;
  fields?: string[];
  templateIds?: string[];
  issueCodes?: string[];
}): boolean {
  if (input.manufacturer && input.manufacturer.trim()) return true;
  if (input.fields && input.fields.length > 0) return true;
  if (input.templateIds && input.templateIds.length > 0) return true;
  if (input.issueCodes && input.issueCodes.length > 0) return true;
  return false;
}
