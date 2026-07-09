import { useCallback, useEffect, useMemo, useState } from "react";
import { useSchematicStore } from "../store";
import {
  enqueueLibraryDoctorCandidates,
  getLibraryDoctorProposalHistory,
  listLibraryDoctorProposals,
  previewLibraryDoctorGeneration,
  reviewLibraryDoctorProposal,
  type LibraryDoctorEnqueueResult,
  type LibraryDoctorProposal,
  type LibraryDoctorProposalCandidate,
  type LibraryDoctorProposalEvent,
  type LibraryDoctorProposalStatus,
  type LibraryDoctorReviewActionStatus,
} from "../tatesideApi";
import {
  availableLibraryDoctorReviewActions,
  classifyLibraryDoctorFeatureError,
  formatLibraryDoctorEnqueueSummary,
  formatLibraryDoctorValue,
  hasMeaningfulLibraryDoctorGenerationScope,
  libraryDoctorReviewActionLabel,
  libraryDoctorStatusLabel,
  libraryDoctorUiHasApplyAction,
  parseCommaSeparatedList,
  summarizeProposalIdentity,
} from "../libraryDoctorUi";

type TabId = "candidates" | "queue";

const STATUS_FILTERS: Array<LibraryDoctorProposalStatus | ""> = [
  "",
  "pending",
  "accepted",
  "rejected",
  "needs-manual-review",
  "superseded",
];

const SAFE_ALIAS_FIELDS = "connectorType, direction, deviceType";

function statusBadgeClass(status: LibraryDoctorProposalStatus): string {
  switch (status) {
    case "pending":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "accepted":
      return "bg-emerald-50 text-emerald-900 border-emerald-200";
    case "rejected":
      return "bg-rose-50 text-rose-900 border-rose-200";
    case "needs-manual-review":
      return "bg-sky-50 text-sky-900 border-sky-200";
    case "superseded":
      return "bg-slate-100 text-slate-700 border-slate-200";
    default:
      return "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]";
  }
}

function riskBadgeClass(risk: string): string {
  if (risk === "high") return "bg-rose-50 text-rose-800 border-rose-200";
  if (risk === "medium") return "bg-amber-50 text-amber-900 border-amber-200";
  return "bg-emerald-50 text-emerald-800 border-emerald-200";
}

function compactValue(value: unknown): string {
  const full = formatLibraryDoctorValue(value);
  if (full.length <= 48) return full;
  return `${full.slice(0, 45)}…`;
}

export default function LibraryDoctorDialog({ onClose }: { onClose: () => void }) {
  const addToast = useSchematicStore((s) => s.addToast);
  const [tab, setTab] = useState<TabId>("queue");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [queueLoading, setQueueLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [enqueueLoading, setEnqueueLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const anyBusy = queueLoading || historyLoading || previewLoading || enqueueLoading || reviewLoading;

  const [queueDisabled, setQueueDisabled] = useState(false);
  const [generationDisabled, setGenerationDisabled] = useState(false);

  // Generation / candidates
  const [manufacturer, setManufacturer] = useState("");
  const [fields, setFields] = useState(SAFE_ALIAS_FIELDS);
  const [templateIds, setTemplateIds] = useState("");
  const [issueCodes, setIssueCodes] = useState("");
  const [maxCandidates, setMaxCandidates] = useState("100");
  const [candidates, setCandidates] = useState<LibraryDoctorProposalCandidate[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [templatesScanned, setTemplatesScanned] = useState(0);
  const [skipped, setSkipped] = useState({ highRisk: 0, ambiguous: 0, duplicateExisting: 0 });
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [enqueueResult, setEnqueueResult] = useState<LibraryDoctorEnqueueResult | null>(null);

  // Queue filters (all backend-supported)
  const [filterStatus, setFilterStatus] = useState<string>("pending");
  const [filterManufacturer, setFilterManufacturer] = useState("");
  const [filterTemplateId, setFilterTemplateId] = useState("");
  const [filterField, setFilterField] = useState("");
  const [filterProposalType, setFilterProposalType] = useState("");
  const [filterConfidence, setFilterConfidence] = useState("");
  const [filterRisk, setFilterRisk] = useState("");
  const [filterSourceIssueCode, setFilterSourceIssueCode] = useState("");
  const [proposals, setProposals] = useState<LibraryDoctorProposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [history, setHistory] = useState<LibraryDoctorProposalEvent[]>([]);
  const [reviewNote, setReviewNote] = useState("");

  const selectedProposal = useMemo(
    () => proposals.find((p) => p.id === selectedProposalId) ?? null,
    [proposals, selectedProposalId],
  );

  const reviewActions = selectedProposal
    ? availableLibraryDoctorReviewActions(selectedProposal.status)
    : [];

  /** Counts derived only from the currently loaded (filtered) queue result. */
  const loadedStatusCounts = useMemo(() => {
    const counts: Record<LibraryDoctorProposalStatus, number> = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      "needs-manual-review": 0,
      superseded: 0,
    };
    for (const p of proposals) counts[p.status] += 1;
    return counts;
  }, [proposals]);

  // Safety: this UI never exposes apply.
  void libraryDoctorUiHasApplyAction();

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setError(null);
    try {
      const list = await listLibraryDoctorProposals({
        status: filterStatus || undefined,
        manufacturer: filterManufacturer.trim() || undefined,
        templateId: filterTemplateId.trim() || undefined,
        field: filterField.trim() || undefined,
        proposalType: filterProposalType || undefined,
        confidence: filterConfidence || undefined,
        risk: filterRisk || undefined,
        sourceIssueCode: filterSourceIssueCode.trim() || undefined,
      });
      setQueueDisabled(false);
      setProposals(list);
      setSelectedProposalId((current) => {
        if (current && list.some((p) => p.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      const classified = classifyLibraryDoctorFeatureError(err, "queue");
      if (classified.kind === "disabled") {
        setQueueDisabled(true);
        setError(classified.message);
      } else {
        setQueueDisabled(false);
        setError(classified.message);
      }
      setProposals([]);
    } finally {
      setQueueLoading(false);
    }
  }, [
    filterStatus,
    filterManufacturer,
    filterTemplateId,
    filterField,
    filterProposalType,
    filterConfidence,
    filterRisk,
    filterSourceIssueCode,
  ]);

  useEffect(() => {
    if (tab === "queue") {
      void loadQueue();
    }
  }, [tab, loadQueue]);

  useEffect(() => {
    if (!selectedProposalId || queueDisabled) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setHistoryLoading(true);
      try {
        // Backend returns oldest → newest (created_at ASC, rowid ASC).
        const events = await getLibraryDoctorProposalHistory(selectedProposalId);
        if (!cancelled) setHistory(events);
      } catch {
        if (!cancelled) setHistory([]);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedProposalId, queueDisabled]);

  const buildScope = () => {
    const max = maxCandidates.trim() ? Number(maxCandidates) : undefined;
    if (max != null && (!Number.isInteger(max) || max < 1)) {
      throw new Error("maxCandidates must be a positive integer");
    }
    const scope = {
      manufacturer: manufacturer.trim() || undefined,
      fields: parseCommaSeparatedList(fields),
      templateIds: parseCommaSeparatedList(templateIds),
      issueCodes: parseCommaSeparatedList(issueCodes),
      maxCandidates: max,
    };
    if (!hasMeaningfulLibraryDoctorGenerationScope(scope)) {
      throw new Error(
        "A generation scope is required: set manufacturer, fields, template IDs, and/or issue codes.",
      );
    }
    return scope;
  };

  const handlePreview = async () => {
    if (generationDisabled) return;
    setPreviewLoading(true);
    setError(null);
    setInfo(null);
    setEnqueueResult(null);
    try {
      const scope = buildScope();
      const result = await previewLibraryDoctorGeneration(scope);
      setGenerationDisabled(false);
      setCandidates(result.candidates);
      // Select all non-high-risk visible candidates (backend excludes high-risk generation).
      setSelectedKeys(new Set(result.candidates.filter((c) => c.risk !== "high").map((c) => c.candidateKey)));
      setTemplatesScanned(result.templatesScanned);
      setSkipped(result.skipped);
      setHasPreviewed(true);
      const msg =
        `Preview complete: ${result.candidates.length} candidate(s) from ${result.templatesScanned} template(s). ` +
        `Skip events (not unique ports/templates) — highRisk: ${result.skipped.highRisk}, ` +
        `ambiguous: ${result.skipped.ambiguous}, duplicateExisting: ${result.skipped.duplicateExisting}.`;
      setInfo(msg);
      addToast(`Previewed ${result.candidates.length} Library Doctor candidate(s)`, "success");
    } catch (err) {
      const classified = classifyLibraryDoctorFeatureError(err, "generation");
      if (classified.kind === "disabled") {
        setGenerationDisabled(true);
        setError(classified.message);
      } else {
        setError(classified.message);
      }
      setCandidates([]);
      setSelectedKeys(new Set());
      setHasPreviewed(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  const applySafeAliasPreset = () => {
    setFields(SAFE_ALIAS_FIELDS);
    setIssueCodes("");
    setInfo(
      "Preset applied: fields connectorType, direction, deviceType. Backend still decides which mappings are safe.",
    );
  };

  const handleEnqueue = async () => {
    if (generationDisabled) return;
    const keys = [...selectedKeys];
    if (keys.length === 0) {
      setError("Select at least one candidate to add to the review queue.");
      return;
    }
    setEnqueueLoading(true);
    setError(null);
    setInfo(null);
    try {
      // Server recomputes candidates; only keys are sent — never client proposed values.
      const result = await enqueueLibraryDoctorCandidates(keys);
      setEnqueueResult(result);
      const msg = `Enqueue result — ${formatLibraryDoctorEnqueueSummary(result)}`;
      setInfo(msg);
      addToast(
        result.created > 0
          ? `Enqueued ${result.created} proposal(s) (queue only — not applied)`
          : "No new proposals created",
        result.created > 0 ? "success" : "info",
      );
      // Refresh preview list (duplicates drop out of preview as duplicateExisting).
      try {
        const scope = buildScope();
        const refreshed = await previewLibraryDoctorGeneration(scope);
        setCandidates(refreshed.candidates);
        setSelectedKeys(new Set());
        setTemplatesScanned(refreshed.templatesScanned);
        setSkipped(refreshed.skipped);
      } catch {
        // keep prior candidates if refresh fails
      }
    } catch (err) {
      const classified = classifyLibraryDoctorFeatureError(err, "generation");
      if (classified.kind === "disabled") setGenerationDisabled(true);
      setError(classified.message);
      addToast(classified.message, "error");
    } finally {
      setEnqueueLoading(false);
    }
  };

  const goToReviewQueue = () => {
    setTab("queue");
    setFilterStatus("pending");
    setEnqueueResult(null);
    void loadQueue();
  };

  const handleReview = async (status: LibraryDoctorReviewActionStatus) => {
    if (!selectedProposal || reviewLoading) return;

    if (status === "accepted" || status === "rejected") {
      const riskNote =
        selectedProposal.risk === "high" && status === "accepted"
          ? "\n\nThis proposal is HIGH risk. Accept still does NOT modify the template."
          : "";
      const ok = window.confirm(
        status === "accepted"
          ? `Accept this proposal in the review queue only?\n\n` +
            `Accepting does not change the device template.${riskNote}`
          : "Reject this proposal?",
      );
      if (!ok) return;
    }

    setReviewLoading(true);
    setError(null);
    setInfo(null);
    try {
      const updated = await reviewLibraryDoctorProposal(selectedProposal.id, {
        status,
        reviewNote: reviewNote.trim() || undefined,
      });
      const msg =
        status === "accepted"
          ? "Accepted in the review queue only. Templates were not modified."
          : `Proposal marked ${libraryDoctorStatusLabel(updated.status)}.`;
      setInfo(msg);
      addToast(msg, "success");
      setReviewNote("");
      await loadQueue();
      setSelectedProposalId(updated.id);
    } catch (err) {
      const classified = classifyLibraryDoctorFeatureError(err, "queue");
      setError(classified.message);
      addToast(classified.message, "error");
    } finally {
      setReviewLoading(false);
    }
  };

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedKeys(new Set(candidates.filter((c) => c.risk !== "high").map((c) => c.candidateKey)));
  };

  const clearSelection = () => setSelectedKeys(new Set());

  const tabClass = (id: TabId) =>
    `px-3 py-1.5 text-xs rounded-t cursor-pointer border border-b-0 transition-colors ${
      tab === id
        ? "bg-white text-[var(--color-text-heading)] font-semibold border-[var(--color-border)]"
        : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text)]"
    }`;

  const btn =
    "px-3 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const btnPrimary =
    "px-3 py-1.5 text-xs rounded border border-blue-700 bg-blue-600 text-white hover:bg-blue-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-doctor-title"
        aria-busy={anyBusy}
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[min(1140px,96vw)] h-[min(860px,94vh)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <div>
            <div id="library-doctor-title" className="text-sm font-semibold text-[var(--color-text-heading)]">
              Library Doctor
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Review-queue only — accepting a proposal does not change the device template
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none cursor-pointer"
            aria-label="Close Library Doctor"
          >
            &times;
          </button>
        </div>

        <div className="px-4 pt-2 flex gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <button type="button" className={tabClass("queue")} onClick={() => setTab("queue")}>
            Review queue
          </button>
          <button type="button" className={tabClass("candidates")} onClick={() => setTab("candidates")}>
            Candidate preview
          </button>
        </div>

        <div className="mx-4 mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-950">
          <strong>Safety:</strong> There is no Apply action. Accepting approves a proposal in the
          review queue only. High-risk mappings (for example euroblock) are not auto-generated.
          Candidate preview requires a scope — the UI does not run an uncontrolled whole-library scan
          by default.
        </div>

        {(error || info) && (
          <div className="px-4 mt-2 space-y-1">
            {error && (
              <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
                {error}
              </div>
            )}
            {info && (
              <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
                {info}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden p-4">
          {queueDisabled && tab === "queue" ? (
            <div className="h-full flex items-center justify-center p-6">
              <div className="max-w-lg text-center space-y-3 text-[12px]">
                <div className="font-semibold text-[var(--color-text-heading)]">Review queue unavailable</div>
                <p className="text-[var(--color-text-muted)]">
                  Library Doctor is not enabled on this TateSide API. Set{" "}
                  <code className="font-mono text-[11px]">TATESIDE_LIBRARY_DOCTOR_ENABLED=1</code> on the API
                  server. This is not an application crash.
                </p>
                <button
                  type="button"
                  className={btn}
                  disabled={queueLoading}
                  onClick={() => {
                    setQueueDisabled(false);
                    void loadQueue();
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : tab === "candidates" ? (
            <div className="h-full flex flex-col gap-3 min-h-0">
              {generationDisabled ? (
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-800 space-y-1">
                  <div className="font-semibold">Candidate generation is disabled</div>
                  <p>
                    Review Queue can still work when only{" "}
                    <code className="font-mono">TATESIDE_LIBRARY_DOCTOR_ENABLED=1</code> is set.
                    Generation also requires{" "}
                    <code className="font-mono">TATESIDE_LIBRARY_DOCTOR_GENERATION_ENABLED=1</code>.
                  </p>
                  <button type="button" className={btn} onClick={() => setTab("queue")}>
                    Back to Review queue
                  </button>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  className={btn}
                  disabled={anyBusy || generationDisabled}
                  onClick={applySafeAliasPreset}
                >
                  Safe alias candidates preset
                </button>
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Sets fields to connectorType, direction, deviceType (backend remains source of truth).
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-[var(--color-text-muted)]">Manufacturer</span>
                  <input
                    value={manufacturer}
                    onChange={(e) => setManufacturer(e.target.value)}
                    placeholder="e.g. QSC"
                    className="border border-[var(--color-border)] rounded px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[var(--color-text-muted)]">Max candidates</span>
                  <input
                    value={maxCandidates}
                    onChange={(e) => setMaxCandidates(e.target.value)}
                    className="border border-[var(--color-border)] rounded px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1 col-span-2">
                  <span className="text-[var(--color-text-muted)]">Fields (comma-separated)</span>
                  <input
                    value={fields}
                    onChange={(e) => setFields(e.target.value)}
                    placeholder="connectorType, direction, deviceType"
                    className="border border-[var(--color-border)] rounded px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[var(--color-text-muted)]">Issue codes (optional)</span>
                  <input
                    value={issueCodes}
                    onChange={(e) => setIssueCodes(e.target.value)}
                    placeholder="INVALID_CONNECTOR_TYPE"
                    className="border border-[var(--color-border)] rounded px-2 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[var(--color-text-muted)]">Template IDs (optional)</span>
                  <input
                    value={templateIds}
                    onChange={(e) => setTemplateIds(e.target.value)}
                    placeholder="id1, id2"
                    className="border border-[var(--color-border)] rounded px-2 py-1.5 font-mono text-[11px]"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={anyBusy || generationDisabled}
                  aria-busy={previewLoading}
                  onClick={() => void handlePreview()}
                >
                  {previewLoading ? "Previewing…" : "Preview candidates"}
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={anyBusy || generationDisabled || candidates.length === 0}
                  onClick={selectAllVisible}
                >
                  Select all visible
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={selectedKeys.size === 0 || anyBusy}
                  onClick={clearSelection}
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={anyBusy || generationDisabled || selectedKeys.size === 0}
                  aria-busy={enqueueLoading}
                  onClick={() => void handleEnqueue()}
                >
                  {enqueueLoading
                    ? "Adding to queue…"
                    : `Add selected to review queue (${selectedKeys.size})`}
                </button>
              </div>

              {enqueueResult && (
                <div
                  className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-950 space-y-2"
                  role="status"
                  aria-live="polite"
                >
                  <div className="font-semibold">Enqueue results</div>
                  <ul className="grid grid-cols-2 gap-1 list-none p-0 m-0">
                    <li>Created: <strong>{enqueueResult.created}</strong></li>
                    <li>Already existing: <strong>{enqueueResult.alreadyExisting}</strong></li>
                    <li>Stale or missing: <strong>{enqueueResult.staleOrMissing}</strong></li>
                    <li>Rejected high-risk: <strong>{enqueueResult.rejectedHighRisk}</strong></li>
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={btnPrimary} onClick={goToReviewQueue}>
                      Open Review queue
                    </button>
                    <button type="button" className={btn} onClick={() => setEnqueueResult(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              <div className="text-[11px] text-[var(--color-text-muted)] flex flex-wrap gap-x-3 gap-y-1">
                <span>Templates scanned: {templatesScanned}</span>
                <span>Candidates: {candidates.length}</span>
                <span title="Generation-event count, not unique ports/templates">
                  highRisk skip events: {skipped.highRisk}
                </span>
                <span title="Generation-event count, not unique ports/templates">
                  ambiguous skip events: {skipped.ambiguous}
                </span>
                <span>duplicate-existing: {skipped.duplicateExisting}</span>
              </div>

              <div className="flex-1 min-h-0 overflow-auto border border-[var(--color-border)] rounded">
                {!hasPreviewed ? (
                  <div className="p-4 text-[11px] text-[var(--color-text-muted)]">
                    Set a scope (or use the safe alias preset), then preview candidates. Nothing is
                    written until you enqueue selected keys.
                  </div>
                ) : candidates.length === 0 ? (
                  <div className="p-4 text-[11px] text-[var(--color-text-muted)]">
                    No candidates for this scope. High-risk mappings are excluded by the backend.
                  </div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                      <tr className="text-left text-[var(--color-text-muted)]">
                        <th className="p-2 w-8" />
                        <th className="p-2">Manufacturer / model</th>
                        <th className="p-2">Field</th>
                        <th className="p-2">Current</th>
                        <th className="p-2">Proposed</th>
                        <th className="p-2">Type</th>
                        <th className="p-2">Conf.</th>
                        <th className="p-2">Risk</th>
                        <th className="p-2">Source</th>
                        <th className="p-2">Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((c) => (
                        <tr key={c.candidateKey} className="border-t border-[var(--color-border)] align-top">
                          <td className="p-2">
                            <input
                              type="checkbox"
                              checked={selectedKeys.has(c.candidateKey)}
                              onChange={() => toggleKey(c.candidateKey)}
                              aria-label={`Select candidate ${c.field}`}
                            />
                          </td>
                          <td className="p-2">
                            <div className="font-medium">
                              {c.manufacturer ?? "—"} {c.modelNumber ?? ""}
                            </div>
                            <div className="text-[10px] text-[var(--color-text-muted)] font-mono">
                              {c.templateId}
                            </div>
                          </td>
                          <td className="p-2 font-mono">{c.field}</td>
                          <td className="p-2 font-mono max-w-[140px] truncate" title={formatLibraryDoctorValue(c.currentValue)}>
                            {compactValue(c.currentValue)}
                          </td>
                          <td className="p-2 font-mono max-w-[140px] truncate" title={formatLibraryDoctorValue(c.proposedValue)}>
                            {compactValue(c.proposedValue)}
                          </td>
                          <td className="p-2">{c.proposalType}</td>
                          <td className="p-2">{c.confidence}</td>
                          <td className="p-2">
                            <span className={`inline-block px-1.5 py-0.5 rounded border ${riskBadgeClass(c.risk)}`}>
                              {c.risk === "low" ? "Low" : c.risk === "medium" ? "Medium" : "High"}
                            </span>
                          </td>
                          <td className="p-2">{c.source}</td>
                          <td className="p-2 font-mono text-[10px]">{c.sourceIssueCode ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex gap-3 min-h-0">
              <div className="w-[44%] flex flex-col min-h-0 gap-2">
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {(
                    [
                      ["pending", "Pending"],
                      ["accepted", "Accepted"],
                      ["rejected", "Rejected"],
                      ["needs-manual-review", "Needs manual review"],
                      ["superseded", "Superseded"],
                    ] as const
                  ).map(([status, label]) => (
                    <button
                      key={status}
                      type="button"
                      className={`px-2 py-1 rounded border cursor-pointer ${
                        filterStatus === status ? statusBadgeClass(status) : "border-[var(--color-border)] text-[var(--color-text-muted)]"
                      }`}
                      onClick={() => setFilterStatus(status)}
                      title="Count from currently loaded results for the active filters only"
                    >
                      {label}: {loadedStatusCounts[status]}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-[var(--color-text-muted)]">
                  Status chips count the currently loaded filtered list only (not a global library total).
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Status</span>
                    <select
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    >
                      {STATUS_FILTERS.map((s) => (
                        <option key={s || "all"} value={s}>
                          {s ? libraryDoctorStatusLabel(s) : "All statuses"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Risk</span>
                    <select
                      value={filterRisk}
                      onChange={(e) => setFilterRisk(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    >
                      <option value="">Any</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Confidence</span>
                    <select
                      value={filterConfidence}
                      onChange={(e) => setFilterConfidence(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    >
                      <option value="">Any</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Proposal type</span>
                    <select
                      value={filterProposalType}
                      onChange={(e) => setFilterProposalType(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    >
                      <option value="">Any</option>
                      <option value="alias-normalization">alias-normalization</option>
                      <option value="taxonomy-classification">taxonomy-classification</option>
                      <option value="field-value-change">field-value-change</option>
                      <option value="completeness-fill">completeness-fill</option>
                      <option value="other">other</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Manufacturer</span>
                    <input
                      value={filterManufacturer}
                      onChange={(e) => setFilterManufacturer(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Field</span>
                    <input
                      value={filterField}
                      onChange={(e) => setFilterField(e.target.value)}
                      placeholder="connectorType"
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Template ID</span>
                    <input
                      value={filterTemplateId}
                      onChange={(e) => setFilterTemplateId(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5 font-mono text-[11px]"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[var(--color-text-muted)]">Source issue code</span>
                    <input
                      value={filterSourceIssueCode}
                      onChange={(e) => setFilterSourceIssueCode(e.target.value)}
                      className="border border-[var(--color-border)] rounded px-2 py-1.5"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className={btn}
                  disabled={anyBusy}
                  aria-busy={queueLoading}
                  onClick={() => void loadQueue()}
                >
                  {queueLoading ? "Loading queue…" : "Refresh queue"}
                </button>
                <div className="flex-1 min-h-0 overflow-auto border border-[var(--color-border)] rounded" aria-busy={queueLoading}>
                  {queueLoading && proposals.length === 0 ? (
                    <div className="p-4 text-[11px] text-[var(--color-text-muted)]">Loading proposals…</div>
                  ) : proposals.length === 0 ? (
                    <div className="p-4 text-[11px] text-[var(--color-text-muted)] space-y-2">
                      <p>
                        No proposals are currently waiting for review with these filters.
                      </p>
                      <p>
                        Use <strong>Candidate preview</strong> to inspect conservative suggestions and
                        add selected candidates to the queue.
                      </p>
                    </div>
                  ) : (
                    <table className="w-full text-[11px]" aria-label="Library Doctor proposals">
                      <thead className="sticky top-0 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                        <tr className="text-left text-[var(--color-text-muted)]">
                          <th className="p-2" scope="col">Device</th>
                          <th className="p-2" scope="col">Field</th>
                          <th className="p-2" scope="col">Change</th>
                          <th className="p-2" scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proposals.map((p) => (
                          <tr
                            key={p.id}
                            className={`border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface-hover)] ${
                              selectedProposalId === p.id ? "bg-blue-50" : ""
                            }`}
                            onClick={() => setSelectedProposalId(p.id)}
                          >
                            <td className="p-2 align-top">
                              <div className="font-medium">{summarizeProposalIdentity(p)}</div>
                              <div className="text-[10px] text-[var(--color-text-muted)]">{p.proposalType}</div>
                            </td>
                            <td className="p-2 align-top font-mono text-[10px]">{p.field}</td>
                            <td className="p-2 align-top font-mono text-[10px] max-w-[140px]">
                              <div className="truncate" title={formatLibraryDoctorValue(p.currentValue)}>
                                {compactValue(p.currentValue)}
                              </div>
                              <div className="truncate text-blue-800" title={formatLibraryDoctorValue(p.proposedValue)}>
                                → {compactValue(p.proposedValue)}
                              </div>
                            </td>
                            <td className="p-2 align-top">
                              <span className={`inline-block px-1.5 py-0.5 rounded border ${statusBadgeClass(p.status)}`}>
                                {libraryDoctorStatusLabel(p.status)}
                              </span>
                              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                                conf {p.confidence} · risk {p.risk}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div className="flex-1 min-w-0 flex flex-col min-h-0 border border-[var(--color-border)] rounded overflow-auto">
                {!selectedProposal ? (
                  <div className="p-4 text-[11px] text-[var(--color-text-muted)]">
                    Select a proposal to inspect current vs proposed values, evidence, and history.
                  </div>
                ) : (
                  <div className="p-3 space-y-3 text-[11px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded border ${statusBadgeClass(selectedProposal.status)}`}>
                        {libraryDoctorStatusLabel(selectedProposal.status)}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded border ${riskBadgeClass(selectedProposal.risk)}`}>
                        Risk: {selectedProposal.risk === "low" ? "Low" : selectedProposal.risk === "medium" ? "Medium" : "High"}
                      </span>
                      <span className="text-[var(--color-text-muted)]">
                        Confidence: {selectedProposal.confidence}
                      </span>
                    </div>

                    <div className="rounded border border-emerald-200 bg-emerald-50/60 px-2 py-1.5 text-[10px] text-emerald-950">
                      Accepting approves this proposal in the review queue. It does not change the
                      device template.
                    </div>

                    <div>
                      <div className="font-semibold text-[var(--color-text-heading)]">
                        {summarizeProposalIdentity(selectedProposal)}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                        templateId: {selectedProposal.templateId}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                        type {selectedProposal.proposalType}
                        {selectedProposal.sourceIssueCode ? ` · issue ${selectedProposal.sourceIssueCode}` : ""}
                        {selectedProposal.sourceIssueGroup ? ` · group ${selectedProposal.sourceIssueGroup}` : ""}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded border border-[var(--color-border)] p-2">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                          Current
                        </div>
                        <div className="font-mono whitespace-pre-wrap break-words">
                          {formatLibraryDoctorValue(selectedProposal.currentValue)}
                        </div>
                      </div>
                      <div className="rounded border border-blue-200 bg-blue-50/40 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-blue-800 mb-1">
                          Proposed (not applied)
                        </div>
                        <div className="font-mono whitespace-pre-wrap break-words">
                          {formatLibraryDoctorValue(selectedProposal.proposedValue)}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Field</div>
                      <div className="font-mono">{selectedProposal.field}</div>
                    </div>

                    {selectedProposal.rationale && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                          Rationale
                        </div>
                        <div>{selectedProposal.rationale}</div>
                      </div>
                    )}

                    {selectedProposal.preview?.arrayDiff && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-[10px] text-emerald-800 font-medium">Added</div>
                          <div className="font-mono whitespace-pre-wrap">
                            {formatLibraryDoctorValue(selectedProposal.preview.arrayDiff.added)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-rose-800 font-medium">Removed</div>
                          <div className="font-mono whitespace-pre-wrap">
                            {formatLibraryDoctorValue(selectedProposal.preview.arrayDiff.removed)}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--color-text-muted)]">
                      <div>Created: {selectedProposal.createdAt}{selectedProposal.createdBy ? ` · ${selectedProposal.createdBy}` : ""}</div>
                      <div>
                        Reviewed:{" "}
                        {selectedProposal.reviewedAt
                          ? `${selectedProposal.reviewedAt}${selectedProposal.reviewedBy ? ` · ${selectedProposal.reviewedBy}` : ""}`
                          : "—"}
                      </div>
                      {selectedProposal.reviewNote && (
                        <div className="col-span-2">Review note: {selectedProposal.reviewNote}</div>
                      )}
                      {selectedProposal.generationKey && (
                        <div className="col-span-2 font-mono break-all">
                          generationKey: {selectedProposal.generationKey}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                        Evidence
                      </div>
                      {selectedProposal.evidenceRefs.length === 0 ? (
                        <div className="text-[var(--color-text-muted)]">No evidence refs</div>
                      ) : (
                        <ul className="space-y-1">
                          {selectedProposal.evidenceRefs.map((ref, index) => (
                            <li key={`${ref.type}-${index}`} className="rounded border border-[var(--color-border)] p-2">
                              <div className="font-medium">{ref.title ?? ref.type}</div>
                              {ref.note && <div className="text-[var(--color-text-muted)]">{ref.note}</div>}
                              {ref.url && (
                                <a href={ref.url} className="text-blue-700 underline" target="_blank" rel="noreferrer">
                                  {ref.url}
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                        History (oldest → newest)
                      </div>
                      {historyLoading ? (
                        <div className="text-[var(--color-text-muted)]" aria-live="polite">Loading history…</div>
                      ) : history.length === 0 ? (
                        <div className="text-[var(--color-text-muted)]">No events</div>
                      ) : (
                        <ul className="space-y-1" aria-label="Proposal history">
                          {history.map((event) => (
                            <li key={event.id} className="font-mono text-[10px] border-l-2 border-[var(--color-border)] pl-2">
                              {event.createdAt} · {event.eventType} ·{" "}
                              {event.oldStatus ?? "∅"} → {event.newStatus}
                              {event.reviewer ? ` · ${event.reviewer}` : ""}
                              {event.reviewNote ? ` · ${event.reviewNote}` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {reviewActions.length > 0 && (
                      <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[var(--color-text-muted)]">Review note (optional)</span>
                          <textarea
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                            rows={2}
                            className="border border-[var(--color-border)] rounded px-2 py-1.5"
                            disabled={reviewLoading}
                          />
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {reviewActions.map((action) => (
                            <button
                              key={action}
                              type="button"
                              className={action === "accepted" ? btnPrimary : btn}
                              disabled={anyBusy}
                              aria-busy={reviewLoading}
                              onClick={() => void handleReview(action)}
                              title={
                                action === "accepted"
                                  ? "Approve in the review queue only. Does not modify the template."
                                  : undefined
                              }
                            >
                              {reviewLoading ? "Saving…" : libraryDoctorReviewActionLabel(action)}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          No Apply control is available by design. Accept ≠ apply.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
