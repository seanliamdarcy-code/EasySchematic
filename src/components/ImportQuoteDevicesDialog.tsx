import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSchematicStore } from "../store";
import type { DeviceTemplate } from "../types";
import type {
  ExtractedQuoteDevice,
  QuoteImportCandidateMatch,
  JetbuiltClientSearchResult,
  JetbuiltIndexStatus,
  JetbuiltProjectSearchResult,
  LibraryMatchStatus,
  ProductBundleComponent,
  QuoteImportDraftReview,
  QuoteImportBundleGroup,
  QuoteImportExtractionResponse,
  QuoteImportResultItem,
} from "../quoteImportTypes";
import {
  fetchTatesideDeviceTemplates,
  fetchJetbuiltIndexStatus,
  importDevicesFromJetbuiltProject,
  importDevicesFromQuote,
  listJetbuiltProjectsForClient,
  previewProductBundleDefinition,
  researchQuoteDevices,
  saveProductBundleDefinition,
  saveTatesideDeviceTemplates,
  searchJetbuiltClients,
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

type PossibleMatchDecision = "use_library_match" | "research_missing";
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

export default function ImportQuoteDevicesDialog({ open, onClose, onLibraryChanged }: Props) {
  const addToast = useSchematicStore((s) => s.addToast);
  const importCustomTemplates = useSchematicStore((s) => s.importCustomTemplates);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importSourceLabel, setImportSourceLabel] = useState<string | null>(null);
  const [jetbuiltQuery, setJetbuiltQuery] = useState("");
  const [jetbuiltClientQuery, setJetbuiltClientQuery] = useState("");
  const [jetbuiltSearching, setJetbuiltSearching] = useState(false);
  const [jetbuiltClientSearching, setJetbuiltClientSearching] = useState(false);
  const [jetbuiltImporting, setJetbuiltImporting] = useState(false);
  const [jetbuiltProjects, setJetbuiltProjects] = useState<JetbuiltProjectSearchResult[]>([]);
  const [jetbuiltClients, setJetbuiltClients] = useState<JetbuiltClientSearchResult[]>([]);
  const [selectedJetbuiltClient, setSelectedJetbuiltClient] = useState<JetbuiltClientSearchResult | null>(null);
  const [clientProjects, setClientProjects] = useState<JetbuiltProjectSearchResult[]>([]);
  const [jetbuiltStatus, setJetbuiltStatus] = useState<JetbuiltIndexStatus | null>(null);
  const [libraryTemplatesById, setLibraryTemplatesById] = useState<Record<string, DeviceTemplate>>({});
  const [extracting, setExtracting] = useState(false);
  const [researching, setResearching] = useState(false);
  const [researchProgress, setResearchProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<QuoteImportExtractionResponse | null>(null);
  const [researchResults, setResearchResults] = useState<QuoteImportDraftReview[]>([]);
  const [possibleMatchDecisions, setPossibleMatchDecisions] = useState<Record<string, PossibleMatchDecision>>({});
  const [selectedDraftKeys, setSelectedDraftKeys] = useState<Set<string>>(new Set());
  const [selectedResearchKeys, setSelectedResearchKeys] = useState<Set<string>>(new Set());
  const [ignoredDraftKeys, setIgnoredDraftKeys] = useState<Set<string>>(new Set());
  const [savedDraftKeys, setSavedDraftKeys] = useState<Set<string>>(new Set());
  const [locallyAddedDraftKeys, setLocallyAddedDraftKeys] = useState<Set<string>>(new Set());
  const [showOutcomeReview, setShowOutcomeReview] = useState(false);
  const [editingDraft, setEditingDraft] = useState<EditingDraftState | null>(null);

  const keyForExtractedDevice = (device: ExtractedQuoteDevice) => (
    device.importItemId || `${device.normalizedLookupKey || "device"}:${device.model}`
  );

  const bundleGroups = useMemo(() => extraction?.bundleGroups ?? [], [extraction]);
  const bundleGroupsById = useMemo(
    () => new Map(bundleGroups.map((group) => [group.id, group])),
    [bundleGroups],
  );
  const activeImportResults = useMemo(
    () => (extraction?.results ?? []).filter((item) => {
      if (!item.bundleGroupId) return true;
      return bundleGroupsById.get(item.bundleGroupId)?.accepted === true;
    }),
    [extraction, bundleGroupsById],
  );
  const standaloneResults = useMemo(
    () => activeImportResults.filter((item) => !item.bundleGroupId),
    [activeImportResults],
  );

  const reset = () => {
    setSelectedFile(null);
    setImportSourceLabel(null);
    setJetbuiltQuery("");
    setJetbuiltClientQuery("");
    setJetbuiltSearching(false);
    setJetbuiltClientSearching(false);
    setJetbuiltImporting(false);
    setJetbuiltProjects([]);
    setJetbuiltClients([]);
    setSelectedJetbuiltClient(null);
    setClientProjects([]);
    setJetbuiltStatus(null);
    setLibraryTemplatesById({});
    setExtracting(false);
    setResearching(false);
    setResearchProgress(null);
    setSaving(false);
    setError(null);
    setExtraction(null);
    setResearchResults([]);
    setPossibleMatchDecisions({});
    setSelectedDraftKeys(new Set());
    setSelectedResearchKeys(new Set());
    setIgnoredDraftKeys(new Set());
    setSavedDraftKeys(new Set());
    setLocallyAddedDraftKeys(new Set());
    setShowOutcomeReview(false);
    setEditingDraft(null);
    onClose();
  };

  const unresolvedPossibleMatches = useMemo(
    () => activeImportResults.filter((item) => item.status === "possible_match" && !possibleMatchDecisions[keyForExtractedDevice(item)]),
    [activeImportResults, possibleMatchDecisions],
  );

  const missingDevices = useMemo(() => {
    if (!extraction) return [];
    return activeImportResults.filter((item) => {
      const key = keyForExtractedDevice(item);
      if (item.status === "missing") return true;
      if (item.status === "possible_match") return possibleMatchDecisions[key] === "research_missing";
      return false;
    });
  }, [extraction, activeImportResults, possibleMatchDecisions]);

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
    return activeImportResults.filter((item) => {
      const key = keyForExtractedDevice(item);
      return item.status === "already_in_library" || possibleMatchDecisions[key] === "use_library_match";
    });
  }, [extraction, activeImportResults, possibleMatchDecisions]);

  const standaloneAlreadyInLibraryItems = useMemo(
    () => alreadyInLibraryItems.filter((item) => !item.bundleGroupId),
    [alreadyInLibraryItems],
  );
  const standalonePossibleMatches = useMemo(
    () => standaloneResults.filter((item) => item.status === "possible_match"),
    [standaloneResults],
  );
  const standaloneUnresolvedMissingDevices = useMemo(
    () => unresolvedMissingDevices.filter((item) => !item.bundleGroupId),
    [unresolvedMissingDevices],
  );

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

  const handleFileSelected = (file: File | null) => {
    setSelectedFile(file);
    setImportSourceLabel(file?.name ?? null);
    setError(null);
    setExtraction(null);
    setResearchResults([]);
    setPossibleMatchDecisions({});
    setSelectedDraftKeys(new Set());
    setSelectedResearchKeys(new Set());
    setIgnoredDraftKeys(new Set());
    setSavedDraftKeys(new Set());
    setLocallyAddedDraftKeys(new Set());
    setShowOutcomeReview(false);
    setResearchProgress(null);
  };

  const refreshJetbuiltStatus = async () => {
    try {
      const status = await fetchJetbuiltIndexStatus();
      setJetbuiltStatus(status);
    } catch {
      setJetbuiltStatus(null);
    }
  };

  const handleExtract = async () => {
    if (!selectedFile) return;
    setExtracting(true);
    setError(null);
    try {
      const response = await importDevicesFromQuote(selectedFile);
      setExtraction(response);
      setImportSourceLabel(selectedFile.name);
      setResearchResults([]);
      setPossibleMatchDecisions({});
      setSelectedDraftKeys(new Set());
      setSelectedResearchKeys(new Set());
      setIgnoredDraftKeys(new Set());
      setSavedDraftKeys(new Set());
      setLocallyAddedDraftKeys(new Set());
      setShowOutcomeReview(false);
      addToast(`Extracted ${response.extractedCount} quote device candidate${response.extractedCount === 1 ? "" : "s"}`, "success");
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Quote import failed";
      setError(message);
    } finally {
      setExtracting(false);
    }
  };

  const handleSearchJetbuilt = async () => {
    const query = jetbuiltQuery.trim();
    if (!query) return;
    setJetbuiltSearching(true);
    setError(null);
    try {
      await refreshJetbuiltStatus();
      const projects = await searchJetbuiltProjects(query);
      setJetbuiltProjects(projects);
      if (projects.length === 0) {
        addToast(`No Jetbuilt projects matched ${query}. Try a P number, project name, or Jetbuilt project id.`, "info");
      }
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt project search failed";
      setError(message);
      setJetbuiltProjects([]);
    } finally {
      setJetbuiltSearching(false);
    }
  };

  const handleSearchJetbuiltClients = async () => {
    const query = jetbuiltClientQuery.trim();
    if (!query) return;
    setJetbuiltClientSearching(true);
    setError(null);
    try {
      await refreshJetbuiltStatus();
      const clients = await searchJetbuiltClients(query);
      setJetbuiltClients(clients);
      setSelectedJetbuiltClient(null);
      setClientProjects([]);
      if (clients.length === 0) {
        addToast(`No Jetbuilt clients matched ${query}`, "info");
      }
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt client search failed";
      setError(message);
      setJetbuiltClients([]);
    } finally {
      setJetbuiltClientSearching(false);
    }
  };

  const handleSelectJetbuiltClient = async (client: JetbuiltClientSearchResult) => {
    setSelectedJetbuiltClient(client);
    setJetbuiltImporting(true);
    setError(null);
    try {
      const projects = await listJetbuiltProjectsForClient(client.id);
      setClientProjects(projects);
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt client projects could not be loaded";
      setError(message);
      setClientProjects([]);
    } finally {
      setJetbuiltImporting(false);
    }
  };

  const handleImportJetbuiltProject = async (project: JetbuiltProjectSearchResult) => {
    setJetbuiltImporting(true);
    setError(null);
    try {
      const response = await importDevicesFromJetbuiltProject(project.id);
      setExtraction(response);
      setImportSourceLabel(project.customId ? `${project.customId} ${project.name}` : project.name);
      setResearchResults([]);
      setPossibleMatchDecisions({});
      setSelectedDraftKeys(new Set());
      setSelectedResearchKeys(new Set());
      setIgnoredDraftKeys(new Set());
      setSavedDraftKeys(new Set());
      setLocallyAddedDraftKeys(new Set());
      setShowOutcomeReview(false);
      addToast(`Imported ${response.extractedCount} Jetbuilt device candidate${response.extractedCount === 1 ? "" : "s"}`, "success");
    } catch (err) {
      const message = err instanceof TatesideApiError ? err.message : err instanceof Error ? err.message : "Jetbuilt project import failed";
      setError(message);
    } finally {
      setJetbuiltImporting(false);
    }
  };

  const handleUseBundleComponents = async (
    group: QuoteImportBundleGroup,
    components: ProductBundleComponent[],
    rememberForFuture: boolean,
  ) => {
    if (!extraction) return;
    const validComponents = components
      .map((component) => ({
        manufacturer: component.manufacturer.trim() || group.manufacturer || "",
        model: component.model.trim(),
        quantityPerBundle: Math.max(1, Math.round(Number(component.quantityPerBundle) || 1)),
        schematicRelevant: component.schematicRelevant === true,
      }))
      .filter((component) => component.manufacturer && component.model && component.schematicRelevant);
    if (validComponents.length === 0) {
      setError("Add at least one physical, schematic-facing bundle component before using this mapping.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const savedBundle = rememberForFuture
        ? await saveProductBundleDefinition({
          id: group.bundleId ?? "",
          manufacturer: group.manufacturer ?? validComponents[0]!.manufacturer,
          sku: group.commercialSku,
          label: group.label || `${group.manufacturer ?? ""} ${group.commercialSku} bundle`.trim(),
          source: "manual",
          components: validComponents,
        })
        : null;
      const preview = await previewProductBundleDefinition({
        group: {
          ...group,
          resolution: "manual",
          accepted: true,
          bundleId: savedBundle?.id ?? group.bundleId,
          warnings: [],
        },
        components: validComponents,
      });

      setExtraction((current) => {
        if (!current) return current;
        const updatedGroup: QuoteImportBundleGroup = {
          ...group,
          resolution: "manual",
          accepted: true,
          bundleId: savedBundle?.id ?? group.bundleId,
          warnings: [],
          components: preview.components,
        };
        const results = [
          ...current.results.filter((item) => item.bundleGroupId !== group.id),
          ...preview.components,
        ];
        return {
          ...current,
          extractedCount: results.length,
          results,
          bundleGroups: (current.bundleGroups ?? []).map((entry) => entry.id === group.id ? updatedGroup : entry),
        };
      });
      if (rememberForFuture) {
        addToast(`Saved ${group.commercialSku} as a reusable TateSide bundle mapping`, "success");
      } else {
        addToast(`Applied ${validComponents.length} approved component${validComponents.length === 1 ? "" : "s"} from ${group.commercialSku}`, "success");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the bundle component mapping");
    } finally {
      setSaving(false);
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
      const response = await researchQuoteDevices(extraction?.fileName ?? selectedFile?.name ?? "quote.pdf", [item.extractedDevice], {
        forceEscalation: true,
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

  const handleCopyPortsFromLibraryCandidate = async (item: QuoteImportResultItem, candidate: QuoteImportCandidateMatch) => {
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
        extractedDevice: { ...item },
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

    return () => {
      cancelled = true;
    };
  }, [open]);

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
                  {showOutcomeReview ? "Import Outcome Review" : "Import Devices"}
                </h2>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  {showOutcomeReview
                    ? "Review exactly how this import was resolved before the future Start Schematic hand-off."
                    : "Import directly from a Jetbuilt project first, then fall back to quote PDF upload only when needed."}
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
            <div className="rounded border p-3 space-y-3" style={{ borderColor: "var(--color-border)" }}>
              <div>
                <div className="text-xs font-medium text-[var(--color-text-heading)]">Import from Jetbuilt Project</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  Preferred route. Search by P number, project name, or Jetbuilt project id.
                </div>
              </div>

              <div className="text-[11px] text-[var(--color-text-muted)]">
                {jetbuiltStatus
                  ? `Jetbuilt index: ${jetbuiltStatus.projectCount} projects, ${jetbuiltStatus.clientCount} clients${jetbuiltStatus.syncedAt ? `, last synced ${new Date(jetbuiltStatus.syncedAt).toLocaleString()}` : ""}${jetbuiltStatus.refreshing ? " (refreshing)" : ""}`
                  : "Jetbuilt index status loads when you search."}
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

              {jetbuiltProjects.length > 0 && (
                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
                  <div className="max-h-56 overflow-y-auto">
                    {jetbuiltProjects.map((project) => (
                      <div
                        key={project.id}
                        className="px-3 py-2 border-b flex items-center gap-3"
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-medium text-[var(--color-text-heading)] truncate">
                            {project.customId ? `${project.customId} - ${project.name}` : project.name}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                            Jetbuilt #{project.id}
                            {project.stage ? ` · ${project.stage}` : ""}
                            {typeof project.itemCount === "number" ? ` · ${project.itemCount} items` : ""}
                            {project.updatedAt ? ` · updated ${new Date(project.updatedAt).toLocaleDateString()}` : ""}
                          </div>
                        </div>
                        <button
                          onClick={() => void handleImportJetbuiltProject(project)}
                          disabled={jetbuiltImporting}
                          className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {jetbuiltImporting ? "Importing..." : "Import"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-2 border-t" style={{ borderColor: "var(--color-border)" }}>
                <div className="text-xs font-medium text-[var(--color-text-heading)]">Browse by Client</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                  Search for a client, then choose one of their Jetbuilt projects from the list.
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={jetbuiltClientQuery}
                  onChange={(e) => setJetbuiltClientQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSearchJetbuiltClients();
                    }
                  }}
                  placeholder="Search Jetbuilt client"
                  className="flex-1 min-w-[240px] bg-white border border-[var(--color-border)] rounded px-2.5 py-1.5 text-xs text-[var(--color-text-heading)] outline-none focus:border-blue-500 placeholder:text-[var(--color-text-muted)]"
                />
                <button
                  onClick={handleSearchJetbuiltClients}
                  disabled={!jetbuiltClientQuery.trim() || jetbuiltClientSearching}
                  className="px-4 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {jetbuiltClientSearching ? "Searching..." : "Search Clients"}
                </button>
              </div>

              {jetbuiltClients.length > 0 && (
                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
                  <div className="max-h-40 overflow-y-auto">
                    {jetbuiltClients.map((client) => (
                      <button
                        key={client.id}
                        onClick={() => void handleSelectJetbuiltClient(client)}
                        className={`w-full text-left px-3 py-2 border-b cursor-pointer hover:bg-[var(--color-surface-hover)] ${
                          selectedJetbuiltClient?.id === client.id ? "bg-blue-50" : ""
                        }`}
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        <div className="text-xs font-medium text-[var(--color-text-heading)]">{client.companyName}</div>
                        <div className="text-[11px] text-[var(--color-text-muted)]">
                          Client #{client.id}
                          {client.primaryContactName ? ` · ${client.primaryContactName}` : ""}
                          {typeof client.projectCount === "number" ? ` · ${client.projectCount} projects` : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedJetbuiltClient && (
                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
                  <div className="px-3 py-2 border-b text-xs font-medium text-[var(--color-text-heading)]" style={{ borderColor: "var(--color-border)" }}>
                    Projects for {selectedJetbuiltClient.companyName}
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {clientProjects.length > 0 ? clientProjects.map((project) => (
                      <div
                        key={`${selectedJetbuiltClient.id}:${project.id}`}
                        className="px-3 py-2 border-b flex items-center gap-3"
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-medium text-[var(--color-text-heading)] truncate">
                            {project.customId ? `${project.customId} - ${project.name}` : project.name}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                            Jetbuilt #{project.id}
                            {project.stage ? ` · ${project.stage}` : ""}
                            {typeof project.itemCount === "number" ? ` · ${project.itemCount} items` : ""}
                            {project.updatedAt ? ` · updated ${new Date(project.updatedAt).toLocaleDateString()}` : ""}
                          </div>
                        </div>
                        <button
                          onClick={() => void handleImportJetbuiltProject(project)}
                          disabled={jetbuiltImporting}
                          className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {jetbuiltImporting ? "Importing..." : "Import"}
                        </button>
                      </div>
                    )) : (
                      <div className="px-3 py-3 text-[11px] text-[var(--color-text-muted)]">
                        No cached projects were found for this client.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="text-xs font-medium text-[var(--color-text-heading)] mb-2">Fallback Quote PDF Upload</div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-xs hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  Choose PDF
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                />
                <div className="text-xs text-[var(--color-text-muted)]">
                  {selectedFile ? selectedFile.name : "Keep this as a fallback when Jetbuilt project import is not suitable."}
                </div>
                <button
                  onClick={handleExtract}
                  disabled={!selectedFile || extracting}
                  className="ml-auto px-4 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {extracting ? "Extracting..." : "Extract Device Models"}
                </button>
              </div>
            </div>

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
                  <SummaryCard label="Possible matches" value={String(activeImportResults.filter((item) => item.status === "possible_match").length)} tone="warning" />
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

                {bundleGroups.length > 0 && (
                  <SectionCard title="Bundle Imports" count={bundleGroups.length}>
                    {bundleGroups.map((group) => (
                      <BundleImportCard
                        key={group.id}
                        group={group}
                        saving={saving}
                        onUseComponents={(components, rememberForFuture) => void handleUseBundleComponents(group, components, rememberForFuture)}
                      >
                        {group.components.length > 0 ? group.components.map((item) => {
                          if (!group.accepted) {
                            return <BundleComponentPreviewRow key={keyForExtractedDevice(item)} item={item} />;
                          }
                          if (item.status === "possible_match") {
                            return (
                              <PossibleMatchRow
                                key={keyForExtractedDevice(item)}
                                item={item}
                                decision={possibleMatchDecisions[keyForExtractedDevice(item)]}
                                onUseLibraryMatch={() => setPossibleDecision(item, "use_library_match")}
                                onResearchMissing={() => setPossibleDecision(item, "research_missing")}
                              />
                            );
                          }
                          return (
                            <ExtractionRow
                              key={keyForExtractedDevice(item)}
                              item={item}
                              selectedForResearch={item.status === "missing" && isResearchSelected(item)}
                              onToggleResearchSelection={item.status === "missing" ? () => toggleResearchSelection(item) : undefined}
                              onCopyPortsFromCandidate={(candidate) => void handleCopyPortsFromLibraryCandidate(item, candidate)}
                            />
                          );
                        }) : (
                          <EmptyState text="No physical components have been approved for this procurement line yet." />
                        )}
                      </BundleImportCard>
                    ))}
                  </SectionCard>
                )}

                <SectionCard title="Already In Library" count={standaloneAlreadyInLibraryItems.length}>
                  {standaloneAlreadyInLibraryItems.length > 0 ? standaloneAlreadyInLibraryItems.map((item) => (
                    <ExtractionRow key={keyForExtractedDevice(item)} item={item} />
                  )) : <EmptyState text="No extracted devices are confirmed as already in the TateSide library yet." />}
                </SectionCard>

                <SectionCard title="Possible Matches" count={standalonePossibleMatches.length}>
                  {standalonePossibleMatches.length > 0 ? (
                    standalonePossibleMatches
                      .map((item) => (
                        <PossibleMatchRow
                          key={keyForExtractedDevice(item)}
                          item={item}
                          decision={possibleMatchDecisions[keyForExtractedDevice(item)]}
                          onUseLibraryMatch={() => setPossibleDecision(item, "use_library_match")}
                          onResearchMissing={() => setPossibleDecision(item, "research_missing")}
                        />
                      ))
                  ) : (
                    <EmptyState text="No possible matches need review." />
                  )}
                </SectionCard>

                <SectionCard title="Missing Devices" count={standaloneUnresolvedMissingDevices.length} action={(<div className="flex items-center gap-2">
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
                  {standaloneUnresolvedMissingDevices.length > 0 ? standaloneUnresolvedMissingDevices.map((item) => (
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
              </>
            )}

            {researchResults.length > 0 && (
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
                <button
                  onClick={() => setShowOutcomeReview(true)}
                  disabled={!extraction || researching || saving}
                  className="px-3 py-1.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Review outcomes →
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
  return device.importItemId || `${device.normalizedLookupKey || "device"}:${device.model}`;
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
        {device.sourceKind === "bundle_component" && device.commercialSku && (
          <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
            Bundle SKU {device.commercialSku}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{detail}</div>
    </div>
  );
}

function bundleComponentsFromGroup(group: QuoteImportBundleGroup): ProductBundleComponent[] {
  if (group.components.length > 0) {
    return group.components.map((item) => ({
      manufacturer: item.manufacturer ?? group.manufacturer ?? "",
      model: item.model,
      quantityPerBundle: item.componentQuantityPerBundle ?? 1,
      schematicRelevant: true,
    }));
  }
  return [{
    manufacturer: group.manufacturer ?? "",
    model: "",
    quantityPerBundle: 1,
    schematicRelevant: true,
  }];
}

function BundleComponentPreviewRow({ item }: { item: QuoteImportResultItem }) {
  return (
    <div className="px-3 py-2 border-b text-xs bg-amber-50/50" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--color-text-heading)]">{[item.manufacturer, item.model].filter(Boolean).join(" ")}</span>
        {typeof item.quantity === "number" && <span className="rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] text-amber-800">Qty {item.quantity}</span>}
        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_CLASSES[item.status]}`}>{STATUS_LABELS[item.status]}</span>
      </div>
      <div className="mt-1 text-[11px] text-amber-800">Proposed component — approve or edit this bundle mapping before researching or saving it.</div>
    </div>
  );
}

function BundleImportCard({
  group,
  saving,
  onUseComponents,
  children,
}: {
  group: QuoteImportBundleGroup;
  saving: boolean;
  onUseComponents: (components: ProductBundleComponent[], rememberForFuture: boolean) => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<ProductBundleComponent[]>(() => bundleComponentsFromGroup(group));
  const beginEditing = () => {
    setDrafts(bundleComponentsFromGroup(group));
    setEditing(true);
  };
  const updateDraft = (index: number, patch: Partial<ProductBundleComponent>) => {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...patch } : draft));
  };
  const validDrafts = drafts.filter((draft) => draft.manufacturer.trim() && draft.model.trim() && draft.schematicRelevant);
  const hasContents = group.components.length > 0;
  const unresolved = !group.accepted;
  const tone = group.resolution === "known_catalogue"
    ? "border-blue-200 bg-blue-50"
    : unresolved
      ? "border-amber-200 bg-amber-50"
      : "border-emerald-200 bg-emerald-50";

  return (
    <details className={`rounded border ${tone}`} open={group.resolution === "known_catalogue"}>
      <summary className="cursor-pointer list-none px-3 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[var(--color-text-heading)]">{[group.manufacturer, group.commercialSku].filter(Boolean).join(" ")}</span>
          <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[10px] text-blue-700">Bundle · Qty {group.quantity ?? 1}</span>
          <span className="rounded-full border border-[var(--color-border)] bg-white px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            {group.resolution === "known_catalogue" ? "Catalogue mapping" : group.resolution === "suggested" ? "Needs review" : group.resolution === "manual" ? "Manual mapping" : "Possible bundle"}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{group.label}</div>
      </summary>
      <div className="border-t" style={{ borderColor: "var(--color-border)" }}>
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)] space-y-1">
          {group.description && <div>{group.description}</div>}
          <div>Jetbuilt SKU: <span className="font-mono">{group.commercialSku}</span></div>
          {(group.room || group.system) && <div>{[group.room ? `Room: ${group.room}` : "", group.system ? `System: ${group.system}` : ""].filter(Boolean).join(" | ")}</div>}
          {group.sourceLineText && <div>Quote text: {group.sourceLineText}</div>}
        </div>
        {group.warnings.length > 0 && (
          <div className="mx-3 mb-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
            {group.warnings.map((warning) => <div key={warning}>{warning}</div>)}
          </div>
        )}
        <div className="px-3 pb-2 flex flex-wrap gap-2">
          {!editing && group.resolution === "suggested" && hasContents && !group.accepted && (
            <button onClick={() => onUseComponents(bundleComponentsFromGroup(group), false)} disabled={saving} className="px-2.5 py-1 rounded bg-blue-500 text-white text-[11px] hover:bg-blue-600 disabled:opacity-40 cursor-pointer">Use suggested components</button>
          )}
          {!editing && !group.bundleId && hasContents && group.accepted && (
            <button onClick={() => onUseComponents(bundleComponentsFromGroup(group), true)} disabled={saving} className="px-2.5 py-1 rounded border border-blue-300 bg-white text-[11px] text-blue-800 hover:bg-blue-50 disabled:opacity-40 cursor-pointer">Remember this bundle definition</button>
          )}
          {!editing && <button onClick={beginEditing} disabled={saving} className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 cursor-pointer">Edit components</button>}
          {unresolved && !editing && <button disabled title="Deliberate paid bundle research is not implemented in this patch." className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px] text-[var(--color-text-muted)] cursor-not-allowed">Research bundle contents — coming next</button>}
        </div>
        {editing && (
          <div className="mx-3 mb-3 rounded border border-[var(--color-border)] bg-white p-2.5 space-y-2">
            <div className="text-[11px] font-medium text-[var(--color-text-heading)]">Physical components used for this import</div>
            {drafts.map((draft, index) => (
              <div key={`${index}-${draft.model}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_70px_auto] gap-2 items-center">
                <input value={draft.manufacturer} onChange={(event) => updateDraft(index, { manufacturer: event.target.value })} placeholder="Manufacturer" className="min-w-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
                <input value={draft.model} onChange={(event) => updateDraft(index, { model: event.target.value })} placeholder="Model" className="min-w-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
                <input type="number" min="1" value={draft.quantityPerBundle} onChange={(event) => updateDraft(index, { quantityPerBundle: Number(event.target.value) || 1 })} title="Quantity per bundle" className="rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
                <button onClick={() => setDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index))} className="text-[11px] text-red-700 hover:underline cursor-pointer">Remove</button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setDrafts((current) => [...current, { manufacturer: group.manufacturer ?? "", model: "", quantityPerBundle: 1, schematicRelevant: true }])} className="px-2.5 py-1 rounded border border-[var(--color-border)] bg-white text-[11px] hover:bg-[var(--color-surface-hover)] cursor-pointer">Add component</button>
              <button onClick={() => onUseComponents(validDrafts, false)} disabled={validDrafts.length === 0 || saving} className="px-2.5 py-1 rounded bg-blue-500 text-white text-[11px] hover:bg-blue-600 disabled:opacity-40 cursor-pointer">Use components for this import</button>
              <button onClick={() => onUseComponents(validDrafts, true)} disabled={validDrafts.length === 0 || saving} className="px-2.5 py-1 rounded border border-blue-300 bg-white text-[11px] text-blue-800 hover:bg-blue-50 disabled:opacity-40 cursor-pointer">Use and remember mapping</button>
              <button onClick={() => setEditing(false)} disabled={saving} className="px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] hover:underline cursor-pointer">Cancel</button>
            </div>
          </div>
        )}
        <div className="border-t" style={{ borderColor: "var(--color-border)" }}>
          <div className="px-3 py-2 text-[11px] font-medium text-[var(--color-text-heading)]">Package contents used for schematic</div>
          {children}
        </div>
      </div>
    </details>
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
            {item.sourceKind === "bundle_component" && item.commercialSku && (
              <span className="px-2 py-0.5 rounded-full border text-[10px] border-blue-200 bg-blue-50 text-blue-700">
                Expanded from bundle SKU {item.commercialSku}
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
            {item.sourceKind === "bundle_component" && (
              <div>
                Bundle: {item.bundleLabel ?? item.commercialSku}
                {typeof item.bundleQuantity === "number" ? ` · bundle qty ${item.bundleQuantity}` : ""}
                {typeof item.componentQuantityPerBundle === "number" ? ` · component qty ${item.componentQuantityPerBundle}` : ""}
              </div>
            )}
            {(item.room || item.system) && (
              <div>{[item.room ? `Room: ${item.room}` : "", item.system ? `System: ${item.system}` : ""].filter(Boolean).join(" | ")}</div>
            )}
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
  onUseLibraryMatch,
  onResearchMissing,
}: {
  item: QuoteImportResultItem;
  decision?: PossibleMatchDecision;
  onUseLibraryMatch: () => void;
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
        {item.sourceKind === "bundle_component" && item.commercialSku && (
          <div>Expanded from bundle SKU {item.commercialSku}</div>
        )}
        {item.sourceLineText && <div>Quote text: {item.sourceLineText}</div>}
      </div>
      <div className="mt-2 space-y-1">
        {item.possibleMatches.map((match) => (
          <div key={match.id} className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
            <div className="font-medium">{match.label}</div>
            <div>{[match.manufacturer, match.modelNumber].filter(Boolean).join(" ")}</div>
            <div className="opacity-80">{match.matchReason}</div>
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
