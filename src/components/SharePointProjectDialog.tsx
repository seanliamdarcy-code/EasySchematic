import { useEffect, useMemo, useState } from "react";
import { useSchematicStore } from "../store";
import {
  listSharePointFolder,
  loadSchematicFromSharePoint,
  publishPdfToSharePoint,
  saveSchematicToSharePoint,
  type SharePointItem,
  type SharePointListing,
} from "../tatesideApi";
import type { ExportedPdfBlob } from "../pdfExport";
import type { SchematicFile } from "../types";

interface Props {
  onClose: () => void;
  onPublishPdf: () => Promise<ExportedPdfBlob | null>;
}

function safeFileName(name: string): string {
  const withoutReservedCharacters = name.replace(/[<>:"/\\|?*]/g, "");
  const cleaned = Array.from(withoutReservedCharacters)
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  return `${cleaned || "Untitled Schematic"}.json`;
}

function derivePdfFileName(jsonFileName: string): string {
  const stem = jsonFileName.trim().replace(/\.json$/i, "").trim();
  return `${stem || "Untitled Schematic"}.pdf`;
}

export default function SharePointProjectDialog({ onClose, onPublishPdf }: Props) {
  const schematicName = useSchematicStore((s) => s.schematicName);
  const exportToJSON = useSchematicStore((s) => s.exportToJSON);
  const importFromJSON = useSchematicStore((s) => s.importFromJSON);
  const setSchematicName = useSchematicStore((s) => s.setSchematicName);
  const addToast = useSchematicStore((s) => s.addToast);

  const [listing, setListing] = useState<SharePointListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingJson, setSavingJson] = useState(false);
  const [publishingPdf, setPublishingPdf] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfMessage, setPdfMessage] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() => safeFileName(schematicName));
  const pdfFileName = useMemo(() => derivePdfFileName(fileName), [fileName]);
  const busy = loading || savingJson || publishingPdf || openingId !== null;

  const folders = useMemo(
    () => listing?.items.filter((item) => item.type === "folder") ?? [],
    [listing],
  );
  const schematicFiles = useMemo(
    () => listing?.items.filter((item) => item.type === "file" && item.name.toLowerCase().endsWith(".json")) ?? [],
    [listing],
  );

  const loadFolder = async (folderId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await listSharePointFolder(folderId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load SharePoint folders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    void listSharePointFolder()
      .then((nextListing) => {
        if (!cancelled) setListing(nextListing);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load SharePoint folders");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!listing) return;
    setSavingJson(true);
    setError(null);
    try {
      const result = await saveSchematicToSharePoint(listing.folderId, fileName, exportToJSON());
      addToast(`Saved to SharePoint: ${result.name}`, "success");
      setSchematicName(result.name.replace(/\.json$/i, ""));
      await loadFolder(listing.folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save to SharePoint");
    } finally {
      setSavingJson(false);
    }
  };

  const handlePublishPdf = async () => {
    if (!listing) return;
    setPublishingPdf(true);
    setError(null);
    setPdfMessage(null);
    try {
      const pdf = await onPublishPdf();
      if (!pdf) {
        const message = "No PDF was generated because the schematic is empty or invalid.";
        setPdfMessage(message);
        addToast(message, "error");
        return;
      }

      const result = await publishPdfToSharePoint(listing.folderId, pdfFileName, pdf.blob);
      const message = `Published PDF to SharePoint: ${result.name}`;
      setPdfMessage(message);
      addToast(message, "success");
      await loadFolder(listing.folderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not publish PDF to SharePoint";
      setError(message);
      setPdfMessage(message);
      addToast(message, "error");
    } finally {
      setPublishingPdf(false);
    }
  };

  const handleOpen = async (item: SharePointItem) => {
    if (publishingPdf) return;
    setOpeningId(item.id);
    setError(null);
    try {
      const data = await loadSchematicFromSharePoint(item.id);
      importFromJSON(data as SchematicFile);
      setSchematicName(item.name.replace(/\.json$/i, ""));
      addToast(`Opened from SharePoint: ${item.name}`, "success");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open SharePoint schematic");
    } finally {
      setOpeningId(null);
    }
  };

  const handleBackdropClose = () => {
    if (!busy) onClose();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={handleBackdropClose}>
      <div
        className="w-[720px] max-w-[94vw] max-h-[88vh] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-heading)]">
              TateSide SharePoint Projects
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
              Browse project folders, open schematic JSON, save this schematic JSON, or explicitly publish the current schematic PDF into the selected folder.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close SharePoint projects"
            className="text-lg leading-none text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-muted)]"
          >
            &times;
          </button>
        </div>

        <div className="px-4 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-1 text-[11px]">
          {(listing?.breadcrumbs ?? [{ id: null, name: "Projects" }]).map((crumb, index, crumbs) => (
            <span key={`${crumb.id ?? "root"}-${index}`} className="flex items-center gap-1">
              <button
                onClick={() => loadFolder(crumb.id)}
                disabled={busy || index === crumbs.length - 1}
                className="rounded px-1.5 py-0.5 text-blue-700 hover:bg-blue-50 disabled:text-[var(--color-text)] disabled:font-medium disabled:hover:bg-transparent"
              >
                {crumb.name}
              </button>
              {index < crumbs.length - 1 && <span className="text-[var(--color-text-muted)]">/</span>}
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-xs text-[var(--color-text-muted)] py-8 text-center">Loading SharePoint folders...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                  Folders
                </h3>
                <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
                  {listing?.parentId !== undefined && listing?.parentId !== null && (
                    <button
                      onClick={() => loadFolder(listing.parentId)}
                      disabled={busy}
                      className="w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-hover)] border-b border-[var(--color-border)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Up one folder
                    </button>
                  )}
                  {folders.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
                      No subfolders here.
                    </div>
                  ) : (
                    folders.map((folder) => (
                      <button
                        key={folder.id}
                        onClick={() => loadFolder(folder.id)}
                        disabled={busy}
                        className="w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-hover)] border-b border-[var(--color-border)] last:border-b-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="font-medium text-[var(--color-text-heading)]">{folder.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                  Schematic JSON
                </h3>
                <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
                  {schematicFiles.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
                      No schematic JSON files in this folder.
                    </div>
                  ) : (
                    schematicFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--color-text-heading)] truncate">{file.name}</div>
                          {file.lastModifiedDateTime && (
                            <div className="text-[10px] text-[var(--color-text-muted)]">
                              {new Date(file.lastModifiedDateTime).toLocaleString()}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => handleOpen(file)}
                          disabled={busy}
                          className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] hover:bg-blue-700 disabled:opacity-50"
                        >
                          {openingId === file.id ? "Opening..." : "Open"}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-border)] flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              JSON file name
            </label>
            <input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              disabled={busy}
              className="flex-1 rounded border border-[var(--color-border)] bg-white px-2 py-1.5 text-xs outline-none focus:border-blue-500 disabled:opacity-60"
            />
          </div>

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              PDF publish name
            </div>
            <div className="mt-1 text-xs font-medium text-[var(--color-text-heading)]">{pdfFileName}</div>
          </div>

          {pdfMessage && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              {pdfMessage}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={handleSave}
              disabled={!listing || busy || !fileName.trim()}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingJson ? "Saving..." : "Save JSON to Folder"}
            </button>
            <button
              onClick={handlePublishPdf}
              disabled={!listing || busy || !fileName.trim()}
              className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishingPdf ? "Publishing PDF..." : "Publish PDF to Folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
