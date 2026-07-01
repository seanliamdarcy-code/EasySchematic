import { useEffect, useMemo, useRef, useState } from "react";
import { useSchematicStore } from "../store";
import type { DeviceTemplate } from "../types";
import type {
  AiProviderSettings,
  ExtractedQuoteDevice,
  QuoteImportCandidateMatch,
  JetbuiltClientProjectSearchResult,
  JetbuiltIndexStatus,
  JetbuiltProjectSearchResult,
  JetbuiltSearchResponse,
  LibraryMatchStatus,
  QuoteImportDraftReview,
  QuoteImportExtractionResponse,
  QuoteImportResultItem,
} from "../quoteImportTypes";
import {
  fetchAiProviderSettings,
  fetchTatesideDeviceTemplates,
  fetchJetbuiltIndexStatus,
  importDevicesFromJetbuiltProject,
  listLatestJetbuiltProjects,
  researchQuoteDevices,
  saveTatesideDeviceTemplates,
  searchJetbuilt,
  searchJetbuiltProjects,
  TatesideApiError,
} from "../tatesideApi";
import { validateTemplate } from "../import/validate";
import ManageTatesideTemplateDialog from "./ManageTatesideTemplateDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onLibraryChanged?: () => void | Promise<void>;
}

interface EditingDraftState {
  key: string;
  template: DeviceTemplate;
}

type PossibleMatchDecision = "use_library_match" | "use_match_as_template" | "research_missing";
type ImportReviewStep = "import" | "already" | "matches" | "missing";
type OutcomeReviewItem = QuoteImportResultItem | QuoteImportDraftReview;

const STATUS_LABELS: Record<LibraryMatchStatus, string> = {
  already_in_library: "Already in library",
  possible_match: "Possible match",
  missing: "Missing",
};

const STATUS_CLASSES: Record<LibraryMatchStatus, string> = {
  already_in_library: "bg-emerald-100 text-emerald-800 border-emerald-200",
  possible_match: "bg-amber-100 text-amber-800 border-amber-200",
  missing: "bg-red-100 text-red-800 border-red-200",
};

const MAX_PAID_RESEARCH_SELECTION = 5;
const LATEST_JETBUILT_PROJECT_LIMIT = 50;
const AI_RESEARCH_MODEL_STORAGE_KEY = "tateside.ai.researchModel";
const AI_ESCALATION_MODEL_STORAGE_KEY = "tateside.ai.escalationModel";

function readStoredModelChoice(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeStoredModelChoice(key: string, value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      window.localStorage.setItem(key, trimmed);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures; the selected model still applies for this open dialog.
  }
}

export default function ImportQuoteDevicesDialog({ open, onClose, onLibraryChanged }: Props) {
  const addToast = useSchematicStore((s) => s.addToast);
  const importCustomTemplates = useSchematicStore((s) => s.importCustomTemplates);

  const [importSourceLabel, setImportSourceLabel] = useState<string | null>(null);
  const [jetbuiltQuery, setJetbuiltQuery] = useState("");
  const [jetbuiltSearching, setJetbuiltSearching] = useState(false);
  const [latestJetbuiltLoading, setLatestJetbuiltLoading] = useState(false);
  const [jetbuiltImportingProjectId, setJetbuiltImportingProjectId] = useState<string | null>(null);
  const [jetbuiltSearchResults, setJetbuiltSearchResults] = useState<JetbuiltSearchResponse>({ projects: [], clients: [] });
  const [latestJetbuiltProjects, setLatestJetbuiltProjects] = useState<JetbuiltProjectSearchResult[]>([]);
  const [latestJetbuiltHasMore, setLatestJetbuiltHasMore] = useState(true);
  const latestJetbuiltLoadingRef = useRef(false);
  const latestJetbuiltScrollerRef = useRef<HTMLDivElement | null>(null);
  const pendingLatestProjectScrollIdRef = useRef<string | null>(null);
  const [jetbuiltStatus, setJetbuiltStatus] = useState<JetbuiltIndexStatus | null>(null);
  const [aiSettings, setAiSettings] = useState<AiProviderSettings | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [selectedResearchModel, setSelectedResearchModel] = useState(() => readStoredModelChoice(AI_RESEARCH_MODEL_STORAGE_KEY));
  const [selectedEscalationModel, setSelectedEscalationModel] = useState(() => readStoredModelChoice(AI_ESCALATION_MODEL_STORAGE_KEY));
  const [libraryTemplatesById, setLibraryTemplatesById] = useState<Record<string, DeviceTemplate>>({});
  const [researching, setResearching] = useState(false);
  const [researchProgress, setResearchProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<QuoteImportExtractionResponse | null>(null);
  const [researchResults, setResearchResults] = useState<QuoteImportDraftReview[]>([]);
  const [possibleMatchDecisions, setPossibleMatchDecisions] = useState<Record<string, PossibleMatchDecision>>({});
  const [possibleMatchTemplateIds, setPossibleMatchTemplateIds] = useState<Record<string, string>>({});
  const [selectedDraftKeys, setSelectedDraftKeys] = useState<Set<string>>(new Set());
  const [selectedResearchKeys, setSelectedResearchKeys] = useState<Set<string>>(new Set());
  const [ignoredDraftKeys, setIgnoredDraftKeys] = useState<Set<string>>(new Set());
  const [savedDraftKeys, setSavedDraftKeys] = useState<Set<string>>(new Set());
  const [locallyAddedDraftKeys, setLocallyAddedDraftKeys] = useState<Set<string>>(new Set());
  const [reviewStep, setReviewStep] = useState<ImportReviewStep>("import");
  const [showOutcomeReview, setShowOutcomeReview] = useState(false);
  const [editingDraft, setEditingDraft] = useState<EditingDraftState | null>(null);

  const keyForExtractedDevice = (device: ExtractedQuoteDevice) => `${device.normalizedLookupKey || "device"}:${device.model}`;

  const reset = () => {
    setImportSourceLabel(null);
    setJetbuiltQuery("");
    setJetbuiltSearching(false);
    setLatestJetbuiltLoading(false);
    setJetbuiltImportingProjectId(null);
    setJetbuiltSearchResults({ projects: [], clients: [] });
    setLatestJetbuiltProjects([]);
    setLatestJetbuiltHasMore(true);
    setJetbuiltStatus(null);
    setAiSettings(null);
    setAiSettingsOpen(false);
    setLibraryTemplatesById({});
    setResearching(false);
    setResearchProgress(null);
    setSaving(false);
    setError(null);
    setExtraction(null);
    setResearchResults([]);
    setPossibleMatchDecisions({});
    setPossibleMatchTemplateIds({});
    setSelectedDraftKeys(new Set());
    setSelectedResearchKeys(new Set());
    setIgnoredDraftKeys(new Set());
    setSavedDraftKeys(new Set());
    setLocallyAddedDraftKeys(new Set());
    setReviewStep("import");
    setShowOutcomeReview(false);
    setEditingDraft(null);
    onClose();
  };

  const unresolvedPossibleMatches = useMemo(
    () => (extraction?.results ?? []).filter((item) => item.status === "possible_match" && !possibleMatchDecisions[keyForExtractedDevice(item)]),
    [extraction, possibleMatchDecisions],
  );

  const missingDevices = useMemo(() => {
    if (!extraction) return [];
    return extraction.results.filter((item) => {
      const key = keyForExtractedDevice(item);
      if (item.status === "missing") return true;
      if (item.status === "possible_match") return possibleMatchDecisions[key] === "research_missing";
      return false;
    });
  }, [extraction, possibleMatchDecisions]);

  const researchResultKeys = useMemo(
    () => new Set(researchResults.map((item) => keyForExtractedDevice(item.extractedDevice))),
    [researchResults],
  );

  const unresolvedMissingDevices = useMemo(
    () => missingDevices.filter((item) => !researchResultKeys.has(keyForExtractedDevice(item))),
    [missingDevices, researchResultKeys],
  );

  const selectedResearchDevices = useMemo(
    () => unresolvedMissingDevices.filter((item) => selectedResearchKeys.has(keyForExtractedDevice(item))),
    [unresolvedMissingDevices, selectedResearchKeys],
  );

  const alreadyInLibraryItems = useMemo(() => {
    if (!extraction) return [];
    return extraction.results.filter((item) => {
      const key = keyForExtractedDevice(item);
      return item.status === "already_in_library" || possibleMatchDecisions[key] === "use_library_match";
    });
  }, [extraction, possibleMatchDecisions]);

  const readyDrafts = useMemo(
    () => researchResults.filter((item) => item.reviewStatus === "draft_ready" && item.template && !ignoredDraftKeys.has(keyForExtractedDevice(item.extractedDevice))),
    [researchResults, ignoredDraftKeys],
  );

  const savedDrafts = useMemo(
    () => readyDrafts.filter((item) => savedDraftKeys.has(keyForExtractedDevice(item.extractedDevice))),
    [readyDrafts, savedDraftKeys],
  );

  const locallyAddedDrafts = useMemo(
    () => readyDrafts.filter((item) => locallyAddedDraftKeys.has(keyForExtractedDevice(item.extractedDevice))),
    [readyDrafts, locallyAddedDraftKeys],
  );

  const pendingReadyDrafts = useMemo(
    () => readyDrafts.filter((item) => {
      const key = keyForExtractedDevice(item.extractedDevice);
      return !savedDraftKeys.has(key) && !locallyAddedDraftKeys.has(key);
    }),
    [readyDrafts, savedDraftKeys, locallyAddedDraftKeys],
  );

  const manualReviewItems = useMemo(
    () => researchResults.filter((item) => item.reviewStatus === "manual_review_required" && !ignoredDraftKeys.has(keyForExtractedDevice(item.extractedDevice))),
    [researchResults, ignoredDraftKeys],
  );

  const ignoredDrafts = useMemo(
    () => researchResults.filter((item) => ignoredDraftKeys.has(keyForExtractedDevice(item.extractedDevice))),
    [researchResults, ignoredDraftKeys],
  );

  const unresolvedOutcomeItems = useMemo(() => {
    const byKey = new Map<string, QuoteImportResultItem>();
    [...unresolvedPossibleMatches, ...unresolvedMissingDevices].forEach((item) => {
      byKey.set(keyForExtractedDevice(item), item);
    });
    return [...byKey.values()];
  }, [unresolvedPossibleMatches, unresolvedMissingDevices]);

  const selectedPendingDraftKeys = useMemo(
    () => pendingReadyDrafts
      .filter((item) => selectedDraftKeys.has(keyForExtractedDevice(item.extractedDevice)))
      .map((item) => keyForExtractedDevice(item.extractedDevice)),
    [pendingReadyDrafts, selectedDraftKeys],
  );

  const selectedDraftTemplates = useMemo(
    () => pendingReadyDrafts
      .filter((item) => selectedDraftKeys.has(keyForExtractedDevice(item.extractedDevice)))
      .map((item) => item.template)
      .filter((template): template is DeviceTemplate => !!template),
    [pendingReadyDrafts, selectedDraftKeys],
  );

  const possibleMatchItems = useMemo(
    () => (extraction?.results ?? []).filter((item) => item.status === "possible_match"),
    [extraction],
  );

  const hasImportedDevices = !!extraction;
  const reviewStepTitle: Record<ImportReviewStep, string> = {
    import: "Import Devices",
    already: "Already In Library",
    matches: "Possible Matches",
    missing: "Missing Devices",
  };

  const goToReviewStep = (step: ImportReviewStep) => {
    setShowOutcomeReview(false);
    setReviewStep(step);
  };

  const goToNextReviewStep = () => {
    if (!extraction) return;
    if (reviewStep === "import") goToReviewStep("already");
    else if (reviewStep === "already") goToReviewStep("matches");
    else if (reviewStep === "matches") goToReviewStep("missing");
    else setShowOutcomeReview(true);
  };

  const goToPreviousReviewStep = () => {
    if (reviewStep === "missing") goToReviewStep("matches");
    else if (reviewStep === "matches") goToReviewStep("already");
    else if (reviewStep === "already") goToReviewStep("import");
  };

  const nextReviewLabel =
    reviewStep === "import"
      ? "Next: already in library"
      : reviewStep === "already"
        ? "Next: possible matches"
        : reviewStep === "matches"
          ? "Next: missing devices"
          : "Review outcomes";

  const refreshJetbuiltStatus = async () => {
    try {
      const status = await fetchJetbuiltIndexStatus();
      setJetbuiltStatus(status);
    } catch {
      setJetbuiltStatus(null);
    }
  };

  const loadLatestJetbuiltProjects = async (options: { showEmptyToast?: boolean; append?: boolean } = {}) => {
    if (latestJetbuiltLoadingRef.current) return;
    if (options.append && !latestJetbuiltHasMore) return;

    const offset = options.append ? latestJetbuiltProjects.length : 0;
    latestJetbuiltLoadingRef.current = true;
    setLatestJetbuiltLoading(true);
    setError(null);
    try {
      await refreshJetbuiltStatus();
      const status = await fetchJetbuiltIndexStatus().catch(() => null);
      let projects = await listLatestJetbuiltProjects(LATEST_JETBUILT_PROJECT_LIMIT, offset);
      if (!options.append && projects.length === 0 && (status?.projectCount ?? 0) > 0) {
        projects = await searchJetbuiltProjects("P");
      }
      const currentProjectIds = new Set(latestJetbuiltProjects.map((project) => project.id));
      const appendedProjects = options.append ? projects.filter((project) => !currentProjectIds.has(project.id)) : projects;
      const firstAppendedProjectId = options.append ? appendedProjects[0]?.id ?? null : null;
      pendingLatestProjectScrollIdRef.current = firstAppendedProjectId;
      setLatestJetbuiltProjects((current) => {
        if (!options.append) return projects;
        const seen = new Set(current.map((project) => project.id));
        const appended = projects.filter((project) => !seen.has(project.id));
        return [...current, ...appended];
      });
      setLatestJetbuiltHasMore(
        status ? offset + projects.length < status.projectCount : projects.length === LATEST_JETBUILT_PROJECT_LIMIT,
      );
      if (projects.length === 0 && options.showEmptyToast) {
        const detail = status?.lastError ? ` Last Jetbuilt sync error: ${status.lastError}` : "";
        addToast(`No Jetbuilt projects are available yet.${detail}`, "info");
      }
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Latest Jetbuilt projects could not be loaded";
      setError(message);
      if (!options.append) {
        setLatestJetbuiltProjects([]);
        setLatestJetbuiltHasMore(true);
      }
    } finally {
      latestJetbuiltLoadingRef.current = false;
      setLatestJetbuiltLoading(false);
    }
  };

  const handleLoadLatestJetbuiltProjects = () => {
    void loadLatestJetbuiltProjects({ showEmptyToast: true });
  };

  const handleLoadMoreLatestJetbuiltProjects = () => {
    void loadLatestJetbuiltProjects({ append: true });
  };

  const handleSearchJetbuilt = async () => {
    const query = jetbuiltQuery.trim();
    if (!query) return;
    setJetbuiltSearching(true);
    setError(null);
    try {
      await refreshJetbuiltStatus();
      const results = await searchJetbuilt(query);
      setJetbuiltSearchResults(results);
      if (results.projects.length === 0 && results.clients.length === 0) {
        addToast(`No Jetbuilt matches for ${query}. Try a P number, project name, client, or Jetbuilt project id.`, "info");
      }
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt search failed";
      setError(message);
      setJetbuiltSearchResults({ projects: [], clients: [] });
    } finally {
      setJetbuiltSearching(false);
    }
  };

  const handleImportJetbuiltProject = async (project: JetbuiltProjectSearchResult) => {
    if (jetbuiltImportingProjectId) return;
    setJetbuiltImportingProjectId(project.id);
    setError(null);
    try {
      const response = await importDevicesFromJetbuiltProject(project.id);
      setExtraction(response);
      setImportSourceLabel(project.customId ? `${project.customId} ${project.name}` : project.name);
      setResearchResults([]);
      setPossibleMatchDecisions({});
      setPossibleMatchTemplateIds({});
      setSelectedDraftKeys(new Set());
      setSelectedResearchKeys(new Set());
      setIgnoredDraftKeys(new Set());
      setSavedDraftKeys(new Set());
      setLocallyAddedDraftKeys(new Set());
      setReviewStep("already");
      setShowOutcomeReview(false);
      addToast(`Imported ${response.extractedCount} Jetbuilt device candidate${response.extractedCount === 1 ? "" : "s"}`, "success");
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt project import failed";
      setError(message);
    } finally {
      setJetbuiltImportingProjectId(null);
    }
  };

  const handleResearchMissing = async () => {
    if (!extraction || selectedResearchDevices.length === 0) return;
    if (unresolvedPossibleMatches.length > 0) {
      setError("Review each possible library match before researching missing devices.");
      return;
    }

    const confirmed = window.confirm(
      `This will run paid AI web research for ${selectedResearchDevices.length} device${selectedResearchDevices.length === 1 ? "" : "s"}. Uncertain results will not be automatically upgraded. Continue?`,
    );
    if (!confirmed) return;

    setResearching(true);
    setResearchProgress({ current: 0, total: selectedResearchDevices.length, label: "Starting paid AI research..." });
    setError(null);
    try {
      const response = await researchQuoteDevices(extraction.fileName, selectedResearchDevices, {
        researchModel: selectedResearchModel || undefined,
        escalationModel: selectedEscalationModel || undefined,
        onProgress: (job) => {
          setResearchProgress({
            current: job.completed,
            total: job.total,
            label: job.currentLabel ? `Researching ${job.currentLabel}` : "Starting paid AI research...",
          });
        },
      });
      const resultKeys = new Set(response.results.map((result) => keyForExtractedDevice(result.extractedDevice)));
      setResearchResults((current) => [
        ...current.filter((entry) => !resultKeys.has(keyForExtractedDevice(entry.extractedDevice))),
        ...response.results,
      ]);
      setSelectedResearchKeys((current) => {
        const next = new Set(current);
        resultKeys.forEach((key) => next.delete(key));
        return next;
      });
      setSelectedDraftKeys((current) => {
        const next = new Set(current);
        response.results.forEach((result) => {
          if (result.reviewStatus === "draft_ready" && result.template) {
            next.add(keyForExtractedDevice(result.extractedDevice));
          }
        });
        return next;
      });

      if (response.warnings.length > 0) {
        addToast(response.warnings.join(" "), "info");
      } else {
        addToast(`Researched ${response.results.length} missing device candidate${response.results.length === 1 ? "" : "s"}`, "success");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Missing-device research failed");
    } finally {
      setResearching(false);
      setResearchProgress(null);
    }
  };

  const handleManualStrongerRetry = async (item: QuoteImportDraftReview) => {
    setResearching(true);
    setResearchProgress({ current: 1, total: 1, label: `Retrying ${item.extractedDevice.model}` });
    setError(null);
    try {
      const response = await researchQuoteDevices(extraction?.fileName ?? importSourceLabel ?? "Jetbuilt import", [item.extractedDevice], {
        forceEscalation: true,
        researchModel: selectedResearchModel || undefined,
        escalationModel: selectedEscalationModel || undefined,
      });
      const replacement = response.results[0];
      if (!replacement) return;
      setResearchResults((current) => current.map((entry) => (
        keyForExtractedDevice(entry.extractedDevice) === keyForExtractedDevice(item.extractedDevice) ? replacement : entry
      )));
      if (replacement.reviewStatus === "draft_ready") {
        setSelectedDraftKeys((current) => new Set([...current, keyForExtractedDevice(replacement.extractedDevice)]));
      }
      addToast(`Retried ${item.extractedDevice.model} with the stronger research model`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setResearching(false);
      setResearchProgress(null);
    }
  };

  const handleSaveSelectedToLibrary = async () => {
    if (selectedDraftTemplates.length === 0 || !extraction) return;
    setSaving(true);
    setError(null);
    try {
      const templatesToSave = selectedDraftTemplates.map((template) => {
        const { id, version, ...rest } = template;
        void id;
        void version;
        return {
          ...rest,
          aiMetadata: rest.aiMetadata
            ? {
              ...rest.aiMetadata,
              approvedAt: new Date().toISOString(),
            }
            : rest.aiMetadata,
        };
      });
      const result = await saveTatesideDeviceTemplates(templatesToSave, {
        source: "import-workflow-approval",
        note: `Approved from import workflow: ${importSourceLabel ?? extraction.fileName}`,
      });
      await onLibraryChanged?.();
      setSavedDraftKeys((current) => new Set([...current, ...selectedPendingDraftKeys]));
      setSelectedDraftKeys((current) => {
        const next = new Set(current);
        selectedPendingDraftKeys.forEach((key) => next.delete(key));
        return next;
      });
      addToast(`Saved ${result.templates.length} reviewed device draft${result.templates.length === 1 ? "" : "s"} to the TateSide library`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save selected devices");
    } finally {
      setSaving(false);
    }
  };

  const handleAddSelectedLocally = () => {
    if (selectedDraftTemplates.length === 0) return;
    importCustomTemplates(selectedDraftTemplates);
    setLocallyAddedDraftKeys((current) => new Set([...current, ...selectedPendingDraftKeys]));
    setSelectedDraftKeys((current) => {
      const next = new Set(current);
      selectedPendingDraftKeys.forEach((key) => next.delete(key));
      return next;
    });
    addToast(`Added ${selectedDraftTemplates.length} reviewed device draft${selectedDraftTemplates.length === 1 ? "" : "s"} locally`, "success");
  };

  const setPossibleDecision = (item: QuoteImportResultItem, decision: PossibleMatchDecision) => {
    const key = keyForExtractedDevice(item);
    setPossibleMatchDecisions((current) => ({ ...current, [key]: decision }));
    if (decision !== "use_match_as_template") {
      setPossibleMatchTemplateIds((current) => {
        const { [key]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
    }
  };

  const toggleDraftSelected = (item: QuoteImportDraftReview) => {
    const key = keyForExtractedDevice(item.extractedDevice);
    setSelectedDraftKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleIgnored = (item: QuoteImportDraftReview) => {
    const key = keyForExtractedDevice(item.extractedDevice);
    setIgnoredDraftKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const isResearchSelected = (item: QuoteImportResultItem) => selectedResearchKeys.has(keyForExtractedDevice(item));

  const toggleResearchSelection = (item: QuoteImportResultItem) => {
    const key = keyForExtractedDevice(item);
    setSelectedResearchKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      if (next.size >= MAX_PAID_RESEARCH_SELECTION) {
        addToast(`Paid AI research is limited to ${MAX_PAID_RESEARCH_SELECTION} devices per batch.`, "info");
        return current;
      }
      next.add(key);
      return next;
    });
  };

  const selectResearchBatch = () => {
    const selected = unresolvedMissingDevices.slice(0, MAX_PAID_RESEARCH_SELECTION);
    setSelectedResearchKeys(new Set(selected.map(keyForExtractedDevice)));
    if (unresolvedMissingDevices.length > MAX_PAID_RESEARCH_SELECTION) {
      addToast(`Selected the first ${MAX_PAID_RESEARCH_SELECTION} devices. Run the next group separately.`, "info");
    }
  };

  const clearResearchSelection = () => setSelectedResearchKeys(new Set());

  const handleDraftEdited = (updatedTemplate: DeviceTemplate) => {
    if (!editingDraft) return;
    setResearchResults((current) => current.map((item) => (
      keyForExtractedDevice(item.extractedDevice) === editingDraft.key
        ? { ...item, template: updatedTemplate }
        : item
    )));
    setEditingDraft(null);
  };

  const ensureLibraryTemplatesLoaded = async (): Promise<Record<string, DeviceTemplate>> => {
    if (Object.keys(libraryTemplatesById).length > 0) return libraryTemplatesById;
    const templates = await fetchTatesideDeviceTemplates();
    const byId = Object.fromEntries(
      templates
        .filter((template): template is DeviceTemplate & { id: string } => typeof template.id === "string" && template.id.length > 0)
        .map((template) => [template.id, template]),
    );
    setLibraryTemplatesById(byId);
    return byId;
  };

  const handleCopyPortsFromLibraryCandidate = async (
    item: QuoteImportResultItem,
    candidate: QuoteImportCandidateMatch,
    decision?: PossibleMatchDecision,
  ) => {
    setError(null);
    try {
      const templatesById = await ensureLibraryTemplatesLoaded();
      const sourceTemplate = templatesById[candidate.id];
      if (!sourceTemplate) {
        throw new Error("The selected TateSide library device could not be loaded");
      }

      const copiedTemplate: DeviceTemplate = {
        ...sourceTemplate,
        label: [item.manufacturer ?? sourceTemplate.manufacturer, item.model].filter(Boolean).join(" "),
        shortName: item.model,
        manufacturer: item.manufacturer ?? sourceTemplate.manufacturer,
        modelNumber: item.model,
        ports: sourceTemplate.ports.map((port, index) => ({
          ...port,
          id: `port-copy-${index + 1}`,
        })),
      };
      const validation = validateTemplate(copiedTemplate);
      const draftKey = keyForExtractedDevice(item);
      const review: QuoteImportDraftReview = {
        extractedDevice: {
          manufacturer: item.manufacturer,
          model: item.model,
          description: item.description,
          quantity: item.quantity,
          sourceLineText: item.sourceLineText,
          normalizedLookupKey: item.normalizedLookupKey,
        },
        template: copiedTemplate,
        metadata: null,
        draftSource: "library_port_copy",
        validation,
        reviewStatus: validation.ok ? "draft_ready" : "manual_review_required",
        error: null,
        portSummary: copiedTemplate.ports.slice(0, 8).map((port) => `${port.label} - ${port.signalType} ${port.direction}`),
      };

      setResearchResults((current) => {
        const remaining = current.filter((entry) => keyForExtractedDevice(entry.extractedDevice) !== draftKey);
        return [...remaining, review];
      });
      setSelectedResearchKeys((current) => {
        const next = new Set(current);
        next.delete(draftKey);
        return next;
      });
      if (validation.ok) {
        setSelectedDraftKeys((current) => new Set([...current, draftKey]));
      }
      if (decision) {
        setPossibleMatchDecisions((current) => ({ ...current, [draftKey]: decision }));
        if (decision === "use_match_as_template") {
          setPossibleMatchTemplateIds((current) => ({ ...current, [draftKey]: candidate.id }));
        }
      }
      addToast(`Copied ports from ${candidate.label} into a draft for ${item.model}`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy ports from the TateSide library device");
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void fetchJetbuiltIndexStatus()
      .then((status) => {
        if (!cancelled) setJetbuiltStatus(status);
      })
      .catch(() => {
        if (!cancelled) setJetbuiltStatus(null);
      });

    if (latestJetbuiltProjects.length === 0) {
      void loadLatestJetbuiltProjects();
    }

    void fetchAiProviderSettings()
      .then((settings) => {
        if (cancelled) return;
        setAiSettings(settings);
        setSelectedResearchModel((current) => current || readStoredModelChoice(AI_RESEARCH_MODEL_STORAGE_KEY) || settings.defaults.deviceResearchModel);
        setSelectedEscalationModel((current) => current || readStoredModelChoice(AI_ESCALATION_MODEL_STORAGE_KEY) || settings.defaults.deviceEscalationModel);
      })
      .catch(() => {
        if (!cancelled) setAiSettings(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    const projectId = pendingLatestProjectScrollIdRef.current;
    if (!projectId) return;

    window.requestAnimationFrame(() => {
      const scroller = latestJetbuiltScrollerRef.current;
      if (!scroller) return;
      const firstNewRow = Array.from(scroller.querySelectorAll<HTMLElement>("[data-latest-project-id]"))
        .find((row) => row.dataset.latestProjectId === projectId);
      if (!firstNewRow) return;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const rowTop = firstNewRow.getBoundingClientRect().top;
      scroller.scrollTop += rowTop - scrollerTop;
      pendingLatestProjectScrollIdRef.current = null;
    });
  }, [latestJetbuiltProjects]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        onClick={reset}
      >
        <div
          className="rounded-lg shadow-xl w-[1100px] max-w-[97vw] max-h-[94vh] flex flex-col"
          style={{
            backgroundColor: "var(--color-surface)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 border-b" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-heading)" }}>
                  {showOutcomeReview ? "Import Outcome Review" : reviewStepTitle[reviewStep]}
                </h2>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  {showOutcomeReview
                    ? "Review exactly how this import was resolved before the future Start Schematic hand-off."
                    : reviewStep === "import"
                      ? "Import directly from Jetbuilt by searching projects, browsing latest projects, or browsing by client."
                      : "Step through the imported project inventory before researching or creating missing devices."}
                </p>
              </div>
              <button onClick={reset} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {showOutcomeReview ? (
              <OutcomeReviewPanel
                importSourceLabel={importSourceLabel}
                extractedCount={extraction?.extractedCount ?? 0}
                alreadyInLibraryItems={alreadyInLibraryItems}
                savedDrafts={savedDrafts}
                locallyAddedDrafts={locallyAddedDrafts}
                pendingReadyDrafts={pendingReadyDrafts}
                manualReviewItems={manualReviewItems}
                ignoredDrafts={ignoredDrafts}
                unresolvedItems={unresolvedOutcomeItems}
              />
            ) : (
              <div className="space-y-4">
            {hasImportedDevices && (
              <div className="rounded border bg-[var(--color-bg)] px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
                <div className="grid grid-cols-4 gap-1">
                  {(["import", "already", "matches", "missing"] as ImportReviewStep[]).map((step) => (
                    <button
                      key={step}
                      type="button"
                      onClick={() => goToReviewStep(step)}
                      className={`min-h-8 rounded px-2 py-1 text-[11px] border cursor-pointer ${
                        reviewStep === step
                          ? "border-blue-300 bg-blue-50 text-blue-800"
                          : "border-[var(--color-border)] bg-white text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                      }`}
                    >
                      {reviewStepTitle[step]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {reviewStep === "import" && (
              <>
            <div className="rounded border p-3 space-y-3" style={{ borderColor: "var(--color-border)" }}>
              <div>
                <div className="text-xs font-medium text-[var(--color-text-heading)]">Import from Jetbuilt Project</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  Search by P number, project name, or Jetbuilt project id.
                </div>
              </div>

              <div className="text-[11px] text-[var(--color-text-muted)]">
                {jetbuiltStatus
                  ? `Jetbuilt index: ${jetbuiltStatus.projectCount} projects, ${jetbuiltStatus.clientCount} clients${jetbuiltStatus.syncedAt ? `, last synced ${new Date(jetbuiltStatus.syncedAt).toLocaleString()}` : ""}${jetbuiltStatus.refreshing ? " (refreshing)" : ""}`
                  : "Jetbuilt index status loads when you search."}
              </div>

              <div className="rounded border bg-[var(--color-bg)]" style={{ borderColor: "var(--color-border)" }}>
                <button
                  type="button"
                  onClick={() => setAiSettingsOpen((current) => !current)}
                  className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left cursor-pointer hover:bg-[var(--color-surface-hover)]"
                >
                  <span className="text-xs font-medium text-[var(--color-text-heading)]">
                    AI model testing
                  </span>
                  <span className="text-[11px] text-[var(--color-text-muted)] truncate">
                    {aiSettings
                      ? `${aiSettings.provider} · ${aiSettings.configured ? "configured" : "missing key"} · ${selectedResearchModel || aiSettings.defaults.deviceResearchModel}`
                      : "OpenRouter settings unavailable"}
                  </span>
                </button>
                {aiSettingsOpen && aiSettings && (
                  <div className="px-3 pb-3 pt-1 border-t space-y-2" style={{ borderColor: "var(--color-border)" }}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="text-[11px] text-[var(--color-text-muted)]">
                        Research model
                        <input
                          type="text"
                          list="openrouter-models"
                          value={selectedResearchModel}
                          onChange={(e) => {
                            setSelectedResearchModel(e.target.value);
                            writeStoredModelChoice(AI_RESEARCH_MODEL_STORAGE_KEY, e.target.value);
                          }}
                          placeholder={aiSettings.defaults.deviceResearchModel}
                          className="mt-1 w-full bg-white border border-[var(--color-border)] rounded px-2.5 py-1.5 text-xs text-[var(--color-text-heading)] outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="text-[11px] text-[var(--color-text-muted)]">
                        Stronger retry model
                        <input
                          type="text"
                          list="openrouter-models"
                          value={selectedEscalationModel}
                          onChange={(e) => {
                            setSelectedEscalationModel(e.target.value);
                            writeStoredModelChoice(AI_ESCALATION_MODEL_STORAGE_KEY, e.target.value);
                          }}
                          placeholder={aiSettings.defaults.deviceEscalationModel}
                          className="mt-1 w-full bg-white border border-[var(--color-border)] rounded px-2.5 py-1.5 text-xs text-[var(--color-text-heading)] outline-none focus:border-blue-500"
                        />
                      </label>
                    </div>
                    <datalist id="openrouter-models">
                      {aiSettings.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </datalist>
                    <div className={`text-[11px] ${aiSettings.configured ? "text-[var(--color-text-muted)]" : "text-amber-700"}`}>
                      {aiSettings.configured
                        ? "Selections apply to the next research run only, so you can compare models without changing server defaults."
                        : "OPENROUTER_API_KEY is not configured on the API server yet."}
                      {aiSettings.modelListError ? ` Model list fallback in use: ${aiSettings.modelListError}` : ""}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={jetbuiltQuery}
                  onChange={(e) => setJetbuiltQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSearchJetbuilt();
                    }
                  }}
                  placeholder="Search P number or project name, for example P-5844 or O2 Meeting Rooms"
                  className="flex-1 min-w-[240px] bg-white border border-[var(--color-border)] rounded px-2.5 py-1.5 text-xs text-[var(--color-text-heading)] outline-none focus:border-blue-500 placeholder:text-[var(--color-text-muted)]"
                />
                <button
                  onClick={handleSearchJetbuilt}
                  disabled={!jetbuiltQuery.trim() || jetbuiltSearching}
                  className="px-4 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {jetbuiltSearching ? "Searching..." : "Search Jetbuilt"}
                </button>
              </div>
              {(jetbuiltSearchResults.projects.length > 0 || jetbuiltSearchResults.clients.length > 0) && (
                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
                  <div className="max-h-56 overflow-y-auto">
                    {jetbuiltSearchResults.projects.map((project) => (
                      <JetbuiltProjectRow
                        key={`project:${project.id}`}
                        project={project}
                        importing={jetbuiltImportingProjectId === project.id}
                        disabled={!!jetbuiltImportingProjectId}
                        onImport={() => void handleImportJetbuiltProject(project)}
                      />
                    ))}
                    {jetbuiltSearchResults.clients.map((client) => (
                      <JetbuiltClientGroup
                        key={`client:${client.id}`}
                        client={client}
                        importingProjectId={jetbuiltImportingProjectId}
                        onImportProject={(project) => void handleImportJetbuiltProject(project)}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-2 border-t" style={{ borderColor: "var(--color-border)" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex-1 min-w-[220px]">
                    <div className="text-xs font-medium text-[var(--color-text-heading)]">Browse Latest Jetbuilt Projects</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                      Load the most recently updated cached projects and import directly from the list.
                    </div>
                  </div>
                  <button
                    onClick={handleLoadLatestJetbuiltProjects}
                    disabled={latestJetbuiltLoading}
                    className="px-4 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {latestJetbuiltLoading ? "Loading..." : latestJetbuiltProjects.length > 0 ? "Refresh Latest" : "Load Latest"}
                  </button>
                </div>
              </div>

              {latestJetbuiltLoading && latestJetbuiltProjects.length === 0 && (
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  Loading latest Jetbuilt projects...
                </div>
              )}

              {latestJetbuiltProjects.length > 0 && (
                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
                  <div ref={latestJetbuiltScrollerRef} className="max-h-56 overflow-y-auto">
                    {latestJetbuiltProjects.map((project) => (
                      <JetbuiltProjectRow
                        key={`latest:${project.id}`}
                        project={project}
                        latestProjectId={project.id}
                        importing={jetbuiltImportingProjectId === project.id}
                        disabled={!!jetbuiltImportingProjectId}
                        onImport={() => void handleImportJetbuiltProject(project)}
                      />
                    ))}
                    <div className="px-3 py-2 text-center text-[11px] text-[var(--color-text-muted)]">
                      {latestJetbuiltHasMore ? (
                        <button
                          type="button"
                          onClick={handleLoadMoreLatestJetbuiltProjects}
                          disabled={latestJetbuiltLoading}
                          className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs text-[var(--color-text-heading)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {latestJetbuiltLoading ? "Loading more projects..." : "Load more projects"}
                        </button>
                      ) : (
                        "All cached projects loaded"
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
              </>
            )}

            {error && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            {extraction && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <SummaryCard label="Extracted devices" value={String(extraction.extractedCount)} tone="default" />
                  <SummaryCard label="Already in library" value={String(alreadyInLibraryItems.length)} tone="success" />
                  <SummaryCard label="Possible matches" value={String(possibleMatchItems.length)} tone="warning" />
                  <SummaryCard label="Missing devices" value={String(unresolvedMissingDevices.length)} tone="danger" />
                </div>

                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  Extraction model: <strong>{extraction.extractionModel}</strong> with <strong>{extraction.extractionReasoningEffort}</strong> reasoning effort.
                </div>

                {importSourceLabel && (
                  <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                    Import source: <strong>{importSourceLabel}</strong>
                  </div>
                )}

                {extraction.warnings.length > 0 && (
                  <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 space-y-1">
                    {extraction.warnings.map((warning, index) => <div key={`${warning}-${index}`}>{warning}</div>)}
                  </div>
                )}

                {reviewStep === "already" && (
                  <SectionCard title="Already In Library" count={alreadyInLibraryItems.length}>
                    {alreadyInLibraryItems.length > 0 ? alreadyInLibraryItems.map((item) => (
                      <ExtractionRow key={keyForExtractedDevice(item)} item={item} />
                    )) : <EmptyState text="No extracted devices are confirmed as already in the TateSide library yet." />}
                  </SectionCard>
                )}

                {reviewStep === "matches" && (
                  <SectionCard title="Possible Matches" count={possibleMatchItems.length}>
                    {possibleMatchItems.length > 0 ? (
                      possibleMatchItems.map((item) => (
                        <PossibleMatchRow
                          key={keyForExtractedDevice(item)}
                          item={item}
                          decision={possibleMatchDecisions[keyForExtractedDevice(item)]}
                          selectedTemplateMatchId={possibleMatchTemplateIds[keyForExtractedDevice(item)]}
                          onUseLibraryMatch={() => setPossibleDecision(item, "use_library_match")}
                          onUseMatchAsTemplate={(match) => void handleCopyPortsFromLibraryCandidate(item, match, "use_match_as_template")}
                          onResearchMissing={() => setPossibleDecision(item, "research_missing")}
                        />
                      ))
                    ) : (
                      <EmptyState text="No possible matches need review." />
                    )}
                  </SectionCard>
                )}

                {reviewStep === "missing" && (
                  <SectionCard title="Missing Devices" count={unresolvedMissingDevices.length} action={(<div className="flex items-center gap-2">
                  <button
                    onClick={handleResearchMissing}
                    disabled={selectedResearchDevices.length === 0 || researching || unresolvedPossibleMatches.length > 0}
                    className="px-3 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {researching
                      ? (researchProgress ? `${researchProgress.current}/${researchProgress.total} Researching...` : "Researching...")
                      : `Research selected with AI (${selectedResearchDevices.length}/${MAX_PAID_RESEARCH_SELECTION})`}
                  </button>
                  <button
                    onClick={selectResearchBatch}
                    disabled={unresolvedMissingDevices.length === 0 || researching}
                    className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    Select all (max {MAX_PAID_RESEARCH_SELECTION})
                  </button><button onClick={clearResearchSelection} disabled={selectedResearchDevices.length === 0 || researching} className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Clear selection</button>
                </div>)}>
                  {researchProgress && researching && (
                    <div className="px-3 py-2 text-[11px] text-blue-700 border-b" style={{ borderColor: "var(--color-border)" }}>
                      {researchProgress.label}
                    </div>
                  )}
                  {unresolvedMissingDevices.length > 0 ? unresolvedMissingDevices.map((item) => (
                    <ExtractionRow
                      key={keyForExtractedDevice(item)}
                      item={item}
                      selectedForResearch={isResearchSelected(item)}
                      onToggleResearchSelection={() => toggleResearchSelection(item)}
                      onCopyPortsFromCandidate={(candidate) => void handleCopyPortsFromLibraryCandidate(item, candidate)}
                    />
                  )) : (
                    <EmptyState text="No devices are queued for research." />
                  )}
                  {unresolvedPossibleMatches.length > 0 && (
                    <div className="mt-2 text-[11px] text-amber-700">
                      Review each possible match before researching missing devices.
                    </div>
                  )}
                  </SectionCard>
                )}
              </>
            )}

            {researchResults.length > 0 && (reviewStep === "matches" || reviewStep === "missing") && (
              <>
                <SectionCard title="Generated Drafts Ready For Review" count={pendingReadyDrafts.length} action={(
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAddSelectedLocally}
                      disabled={selectedDraftTemplates.length === 0}
                      className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Add Selected Locally
                    </button>
                    <button
                      onClick={handleSaveSelectedToLibrary}
                      disabled={selectedDraftTemplates.length === 0 || saving}
                      className="px-3 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {saving ? "Saving..." : `Approve And Save ${selectedDraftTemplates.length || ""}`.trim()}
                    </button>
                  </div>
                )}>
                  {pendingReadyDrafts.length > 0 ? pendingReadyDrafts.map((item) => (
                    <DraftReviewRow
                      key={keyForExtractedDevice(item.extractedDevice)}
                      item={item}
                      selected={selectedDraftKeys.has(keyForExtractedDevice(item.extractedDevice))}
                      ignored={ignoredDraftKeys.has(keyForExtractedDevice(item.extractedDevice))}
                      onToggleSelected={() => toggleDraftSelected(item)}
                      onToggleIgnored={() => toggleIgnored(item)}
                      onEdit={() => setEditingDraft(item.template ? {
                        key: keyForExtractedDevice(item.extractedDevice),
                        template: item.template,
                      } : null)}
                      onRetryStronger={() => handleManualStrongerRetry(item)}
                    />
                  )) : <EmptyState text="No saveable drafts are ready yet." />}
                </SectionCard>

                <SectionCard title="Missing Devices Requiring Manual Review" count={manualReviewItems.length}>
                  {manualReviewItems.length > 0 ? manualReviewItems.map((item) => (
                    <DraftReviewRow
                      key={keyForExtractedDevice(item.extractedDevice)}
                      item={item}
                      selected={false}
                      ignored={ignoredDraftKeys.has(keyForExtractedDevice(item.extractedDevice))}
                      onToggleSelected={undefined}
                      onToggleIgnored={() => toggleIgnored(item)}
                      onEdit={item.template ? () => setEditingDraft({
                        key: keyForExtractedDevice(item.extractedDevice),
                        template: item.template!,
                      }) : undefined}
                      onRetryStronger={item.metadata?.escalationOccurred ? undefined : () => handleManualStrongerRetry(item)}
                    />
                  )) : <EmptyState text="No missing devices are waiting for manual review." />}
                </SectionCard>
              </>
            )}
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-t flex items-center justify-end gap-2" style={{ borderColor: "var(--color-border)" }}>
            {showOutcomeReview ? (
              <>
                <button
                  onClick={() => setShowOutcomeReview(false)}
                  className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  ← Back to resolution
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  Close
                </button>
              </>
            ) : (
              <>
                {reviewStep !== "import" && (
                  <button
                    onClick={goToPreviousReviewStep}
                    className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={goToNextReviewStep}
                  disabled={!hasImportedDevices || researching || saving}
                  className="px-3 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {nextReviewLabel}
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <ManageTatesideTemplateDialog
        open={!!editingDraft}
        template={editingDraft?.template ?? null}
        onClose={() => setEditingDraft(null)}
        onSaved={handleDraftEdited}
        saveMode="create"
        saveSource="ai-quote-import-approval"
        title="Edit Draft Device"
      />
    </>
  );
}

function formatJetbuiltProjectTitle(project: JetbuiltProjectSearchResult): string {
  return project.customId ? `${project.customId} - ${project.name}` : project.name;
}

function formatJetbuiltDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

function JetbuiltProjectRow({
  project,
  latestProjectId,
  importing,
  disabled,
  onImport,
}: {
  project: JetbuiltProjectSearchResult;
  latestProjectId?: string;
  importing: boolean;
  disabled?: boolean;
  onImport: () => void;
}) {
  const updated = formatJetbuiltDate(project.updatedAt);
  return (
    <div
      className="px-3 py-2 border-b flex items-center gap-3"
      data-latest-project-id={latestProjectId}
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-900/80 text-xs text-emerald-100">P</div>
      <div className="flex-1 min-w-0 text-xs">
        <div className="font-medium text-[var(--color-text-heading)] truncate">{formatJetbuiltProjectTitle(project)}</div>
        <div className="text-[11px] text-[var(--color-text-muted)] truncate">
          Jetbuilt #{project.id}
          {project.clientName ? ` · ${project.clientName}` : ""}
          {project.stage ? ` · ${project.stage}` : ""}
          {typeof project.itemCount === "number" ? ` · ${project.itemCount} items` : ""}
          {updated ? ` · updated ${updated}` : ""}
        </div>
      </div>
      <button
        onClick={onImport}
        disabled={disabled || importing}
        className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {importing ? "Importing..." : "Import"}
      </button>
    </div>
  );
}

function JetbuiltClientGroup({
  client,
  importingProjectId,
  onImportProject,
}: {
  client: JetbuiltClientProjectSearchResult;
  importingProjectId: string | null;
  onImportProject: (project: JetbuiltProjectSearchResult) => void;
}) {
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
      <div className="px-3 py-2 border-b flex items-center gap-3 bg-[var(--color-bg)]" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-900/80 text-xs text-blue-100">C</div>
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-medium text-[var(--color-text-heading)] truncate">{client.companyName}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
            Client #{client.id}
            {client.primaryContactName ? ` · ${client.primaryContactName}` : ""}
            {typeof client.projectCount === "number" ? ` · ${client.projectCount} projects` : ""}
          </div>
        </div>
      </div>
      {client.projects.map((project) => (
        <JetbuiltProjectRow
          key={`${client.id}:${project.id}`}
          project={project}
          importing={importingProjectId === project.id}
          disabled={!!importingProjectId}
          onImport={() => onImportProject(project)}
        />
      ))}
    </div>
  );
}
function SectionCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border" style={{ borderColor: "var(--color-border)" }}>
      <div className="px-3 py-2 border-b flex items-center justify-between gap-3" style={{ borderColor: "var(--color-border)" }}>
        <div className="text-xs font-semibold text-[var(--color-text-heading)]">
          {title} <span className="text-[var(--color-text-muted)] font-normal">({count})</span>
        </div>
        {action}
      </div>
      <div className="max-h-[36vh] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "default" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    default: "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-heading)]",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-red-200 bg-red-50 text-red-800",
  }[tone];

  return (
    <div className={`rounded border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function OutcomeReviewPanel({
  importSourceLabel,
  extractedCount,
  alreadyInLibraryItems,
  savedDrafts,
  locallyAddedDrafts,
  pendingReadyDrafts,
  manualReviewItems,
  ignoredDrafts,
  unresolvedItems,
}: {
  importSourceLabel: string | null;
  extractedCount: number;
  alreadyInLibraryItems: QuoteImportResultItem[];
  savedDrafts: QuoteImportDraftReview[];
  locallyAddedDrafts: QuoteImportDraftReview[];
  pendingReadyDrafts: QuoteImportDraftReview[];
  manualReviewItems: QuoteImportDraftReview[];
  ignoredDrafts: QuoteImportDraftReview[];
  unresolvedItems: QuoteImportResultItem[];
}) {
  const completelyResolved = pendingReadyDrafts.length === 0 && manualReviewItems.length === 0 && unresolvedItems.length === 0;
  const onlyReadyDraftsRemain = pendingReadyDrafts.length > 0 && manualReviewItems.length === 0 && unresolvedItems.length === 0;

  return (
    <div className="space-y-4">
      <div className="rounded border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800">
        <div className="font-semibold text-[var(--color-text-heading)]">{importSourceLabel ?? "Imported device inventory"}</div>
        <div className="mt-1">
          This is the session outcome for {extractedCount} extracted device line item{extractedCount === 1 ? "" : "s"}. It will become the hand-off point for Start Schematic in a later phase.
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
        <SummaryCard label="Already in library" value={String(alreadyInLibraryItems.length)} tone="success" />
        <SummaryCard label="Saved to library" value={String(savedDrafts.length)} tone="success" />
        <SummaryCard label="Added locally" value={String(locallyAddedDrafts.length)} tone="default" />
        <SummaryCard label="Ready drafts" value={String(pendingReadyDrafts.length)} tone="warning" />
        <SummaryCard label="Manual review" value={String(manualReviewItems.length)} tone="danger" />
        <SummaryCard label="Ignored" value={String(ignoredDrafts.length)} tone="default" />
        <SummaryCard label="Unresolved" value={String(unresolvedItems.length)} tone="danger" />
      </div>

      <div className={`rounded border px-3 py-2 text-xs ${completelyResolved ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
        {completelyResolved
          ? "All included devices have a library template or a saved/local draft."
          : onlyReadyDraftsRemain
            ? "All devices are matched or drafted, but some ready drafts have not been added to a library yet."
            : "Some devices still need a decision, manual review, or an explicit ignore before this is a clean project inventory."}
      </div>

      <div className="space-y-2">
        <OutcomeReviewSection title="Already in TateSide library" description="Existing shared templates selected directly or accepted from a possible match." items={alreadyInLibraryItems} />
        <OutcomeReviewSection title="Saved to TateSide library in this session" description="New reviewed drafts that were approved and saved to the shared library." items={savedDrafts} />
        <OutcomeReviewSection title="Added locally in this session" description="Drafts added to this browser's local custom-device library only." items={locallyAddedDrafts} />
        <OutcomeReviewSection title="Ready new drafts — not yet added" description="Valid drafts waiting for you to add locally or save to the TateSide library." items={pendingReadyDrafts} />
        <OutcomeReviewSection title="Drafts requiring manual review" description="Research returned a draft, but it needs human checking before it should be used." items={manualReviewItems} />
        <OutcomeReviewSection title="Ignored" description="Research results deliberately excluded from this import outcome." items={ignoredDrafts} />
        <OutcomeReviewSection title="Still unresolved" description="No confirmed library match or device draft has been chosen yet." items={unresolvedItems} />
      </div>
    </div>
  );
}

function OutcomeReviewSection({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: OutcomeReviewItem[];
}) {
  return (
    <details className="rounded border" style={{ borderColor: "var(--color-border)" }}>
      <summary className="px-3 py-2 cursor-pointer list-none flex items-center justify-between gap-3 text-xs">
        <div>
          <div className="font-semibold text-[var(--color-text-heading)]">{title}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{description}</div>
        </div>
        <span className="shrink-0 px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px] text-[var(--color-text-muted)]">
          {items.length}
        </span>
      </summary>
      <div className="border-t max-h-56 overflow-y-auto" style={{ borderColor: "var(--color-border)" }}>
        {items.length > 0 ? items.map((item) => <OutcomeReviewItemRow key={outcomeReviewItemKey(item)} item={item} />) : (
          <EmptyState text="None in this category." />
        )}
      </div>
    </details>
  );
}

function outcomeReviewItemKey(item: OutcomeReviewItem): string {
  const device = "extractedDevice" in item ? item.extractedDevice : item;
  return `${device.normalizedLookupKey || "device"}:${device.model}`;
}

function OutcomeReviewItemRow({ item }: { item: OutcomeReviewItem }) {
  const device = "extractedDevice" in item ? item.extractedDevice : item;
  const detail = "extractedDevice" in item
    ? item.draftSource === "library_port_copy"
      ? "Ports copied from a TateSide library device"
      : item.reviewStatus === "manual_review_required"
        ? "Manual review required"
        : "Generated device draft"
    : device.description || device.sourceLineText || "No additional quote detail captured.";

  return (
    <div className="px-3 py-2 border-b last:border-b-0 text-xs" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--color-text-heading)]">{[device.manufacturer, device.model].filter(Boolean).join(" ")}</span>
        {typeof device.quantity === "number" && (
          <span className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">Qty {device.quantity}</span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function ExtractionRow({
  item,
  selectedForResearch = false,
  onToggleResearchSelection,
  onCopyPortsFromCandidate,
}: {
  item: QuoteImportResultItem;
  selectedForResearch?: boolean;
  onToggleResearchSelection?: () => void;
  onCopyPortsFromCandidate?: (candidate: QuoteImportCandidateMatch) => void;
}) {
  const portReuseCandidates = item.portReuseCandidates ?? [];
  return (
    <div className="px-3 py-3 border-b text-xs" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className="font-medium text-[var(--color-text-heading)]">
              {[item.manufacturer, item.model].filter(Boolean).join(" ")}
            </span>
            <span className={`px-2 py-0.5 rounded-full border text-[10px] ${STATUS_CLASSES[item.status]}`}>
              {STATUS_LABELS[item.status]}
            </span>
            {typeof item.quantity === "number" && (
              <span className="text-[10px] rounded bg-[var(--color-bg)] px-2 py-0.5 border border-[var(--color-border)]">
                Qty {item.quantity}
              </span>
            )}
            {selectedForResearch && (
              <span className="px-2 py-0.5 rounded-full border text-[10px] border-blue-200 bg-blue-50 text-blue-700">
                Selected for paid AI research
              </span>
            )}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] space-y-0.5">
            {item.description && <div>{item.description}</div>}
            {item.sourceLineText && <div>Quote text: {item.sourceLineText}</div>}
            <div>Lookup key: <span className="font-mono">{item.normalizedLookupKey || "(none)"}</span></div>
          </div>
          {item.exactMatch && (
            <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11px] text-emerald-800">
              <div className="font-medium">{item.exactMatch.label}</div>
              <div>{[item.exactMatch.manufacturer, item.exactMatch.modelNumber].filter(Boolean).join(" ")}</div>
              <div className="opacity-80">{item.exactMatch.matchReason}</div>
            </div>
          )}
          {portReuseCandidates.length > 0 && onCopyPortsFromCandidate && (
            <div className="mt-2 space-y-1">
              <div className="text-[11px] font-medium text-[var(--color-text-heading)]">
                Similar TateSide devices you can copy ports from first
              </div>
              {portReuseCandidates.map((candidate) => (
                <div key={candidate.id} className="rounded border border-blue-200 bg-blue-50 px-2.5 py-2 text-[11px] text-blue-800">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{candidate.label}</div>
                      <div>{[candidate.manufacturer, candidate.modelNumber].filter(Boolean).join(" ")}</div>
                      <div className="opacity-80">{candidate.matchReason}</div>
                    </div>
                    <button
                      onClick={() => onCopyPortsFromCandidate(candidate)}
                      className="shrink-0 px-2.5 py-1 rounded border border-blue-300 bg-white text-[11px] hover:bg-blue-100 cursor-pointer"
                    >
                      Copy ports
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {onToggleResearchSelection && (
          <label className="shrink-0 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={selectedForResearch}
              onChange={onToggleResearchSelection}
            />
            Include in paid AI research
          </label>
        )}
      </div>
    </div>
  );
}

function PossibleMatchRow({
  item,
  decision,
  selectedTemplateMatchId,
  onUseLibraryMatch,
  onUseMatchAsTemplate,
  onResearchMissing,
}: {
  item: QuoteImportResultItem;
  decision?: PossibleMatchDecision;
  selectedTemplateMatchId?: string;
  onUseLibraryMatch: () => void;
  onUseMatchAsTemplate: (match: QuoteImportCandidateMatch) => void;
  onResearchMissing: () => void;
}) {
  return (
    <div className="px-3 py-3 border-b text-xs" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <span className="font-medium text-[var(--color-text-heading)]">
          {[item.manufacturer, item.model].filter(Boolean).join(" ")}
        </span>
        <span className={`px-2 py-0.5 rounded-full border text-[10px] ${STATUS_CLASSES[item.status]}`}>
          {STATUS_LABELS[item.status]}
        </span>
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)] space-y-0.5">
        {item.description && <div>{item.description}</div>}
        {item.sourceLineText && <div>Quote text: {item.sourceLineText}</div>}
      </div>
      <div className="mt-2 space-y-1">
        {item.possibleMatches.map((match) => (
          <div key={match.id} className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{match.label}</div>
                <div>{[match.manufacturer, match.modelNumber].filter(Boolean).join(" ")}</div>
                <div className="opacity-80">{match.matchReason}</div>
              </div>
              <button
                onClick={() => onUseMatchAsTemplate(match)}
                className={`shrink-0 px-2.5 py-1 rounded text-[11px] border cursor-pointer ${
                  decision === "use_match_as_template" && selectedTemplateMatchId === match.id
                    ? "border-blue-300 bg-blue-100 text-blue-800"
                    : "border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                }`}
              >
                Use as template
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={onUseLibraryMatch}
          className={`px-2.5 py-1 rounded text-[11px] border cursor-pointer ${
            decision === "use_library_match"
              ? "border-emerald-300 bg-emerald-100 text-emerald-800"
              : "border-[var(--color-border)] bg-white text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          }`}
        >
          Use TateSide library match
        </button>
        <button
          onClick={onResearchMissing}
          className={`px-2.5 py-1 rounded text-[11px] border cursor-pointer ${
            decision === "research_missing"
              ? "border-blue-300 bg-blue-100 text-blue-800"
              : "border-[var(--color-border)] bg-white text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          }`}
        >
          Research as missing device
        </button>
      </div>
    </div>
  );
}

function DraftReviewRow({
  item,
  selected,
  ignored,
  onToggleSelected,
  onToggleIgnored,
  onEdit,
  onRetryStronger,
}: {
  item: QuoteImportDraftReview;
  selected: boolean;
  ignored: boolean;
  onToggleSelected?: () => void;
  onToggleIgnored: () => void;
  onEdit?: () => void;
  onRetryStronger?: () => void;
}) {
  const template = item.template;
  const metadata = item.metadata;
  return (
    <div className={`px-3 py-3 border-b text-xs ${ignored ? "opacity-50" : ""}`} style={{ borderColor: "var(--color-border)" }}>
      <div className="flex flex-wrap items-start gap-3">
        {onToggleSelected ? (
          <input type="checkbox" checked={selected} onChange={onToggleSelected} className="mt-1" />
        ) : (
          <div className="w-4" />
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[var(--color-text-heading)]">
              {[item.extractedDevice.manufacturer, item.extractedDevice.model].filter(Boolean).join(" ")}
            </span>
            <span className={`px-2 py-0.5 rounded-full border text-[10px] ${
              item.reviewStatus === "draft_ready"
                ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                : "border-red-200 bg-red-100 text-red-800"
            }`}>
              {item.reviewStatus === "draft_ready" ? "Draft ready" : "Manual review"}
            </span>
            {metadata && (
              <span className="px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 text-[10px]">
                {metadata.modelUsed}
              </span>
            )}
            {item.draftSource === "library_port_copy" && (
              <span className="px-2 py-0.5 rounded-full border border-violet-200 bg-violet-50 text-violet-700 text-[10px]">
                Copied from library ports
              </span>
            )}
          </div>

          {template ? (
            <div className="text-[11px] text-[var(--color-text-muted)] space-y-0.5">
              <div>{template.label}</div>
              <div>{template.deviceType} · {template.category} · {template.ports.length} ports</div>
              {item.portSummary.length > 0 && <div>Ports: {item.portSummary.join("; ")}</div>}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              No valid template draft is available yet.
            </div>
          )}

          {metadata && (
            <div className="text-[11px] text-[var(--color-text-muted)] space-y-0.5">
              <div>Confidence: <strong>{metadata.confidence}</strong></div>
              <div>Official source found: <strong>{metadata.officialSourceFound ? "Yes" : "No"}</strong></div>
              <div>Escalation: <strong>{metadata.escalationOccurred ? `Yes${metadata.escalationReason ? ` - ${metadata.escalationReason}` : ""}` : "No"}</strong></div>
            </div>
          )}

          {metadata?.sourceReferences && metadata.sourceReferences.length > 0 && (
            <div className="space-y-1">
              {metadata.sourceReferences.map((source, index) => (
                <a
                  key={`${source.url}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-[11px] text-blue-600 hover:underline"
                >
                  {source.title}
                </a>
              ))}
            </div>
          )}

          {(item.validation.errors.length > 0 || item.validation.warnings.length > 0 || metadata?.warnings?.length || item.error) && (
            <div className="space-y-1">
              {item.error && <div className="text-[11px] text-red-700">{item.error}</div>}
              {item.validation.errors.map((entry, index) => <div key={`error-${index}`} className="text-[11px] text-red-700">{entry}</div>)}
              {item.validation.warnings.map((entry, index) => <div key={`warning-${index}`} className="text-[11px] text-amber-700">{entry}</div>)}
              {(metadata?.warnings ?? []).map((entry, index) => <div key={`meta-warning-${index}`} className="text-[11px] text-amber-700">{entry}</div>)}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {onEdit && template && (
              <button
                onClick={onEdit}
                className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                Edit Draft
              </button>
            )}
            {onRetryStronger && (
              <button
                onClick={onRetryStronger}
                className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                Verify with stronger AI (paid)
              </button>
            )}
            <button
              onClick={onToggleIgnored}
              className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] cursor-pointer"
            >
              {ignored ? "Restore" : "Ignore"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">{text}</div>;
}
