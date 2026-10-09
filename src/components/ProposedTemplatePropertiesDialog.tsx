import type { LibraryDoctorEvidenceRef } from "../tatesideApi";
import type {
  DuplicateCheck,
  HistoricalUsageEvidence,
  NewTemplateProposalValue,
  RelatedTemplateRef,
  TaxonomyValidationResult,
} from "../libraryDoctorProposalPreview";

export interface ProposedTemplatePropertiesDialogProps {
  value: NewTemplateProposalValue;
  evidenceRefs: LibraryDoctorEvidenceRef[];
  rationale: string | null;
  onClose: () => void;
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function Field({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="text-xs text-[var(--color-text-heading)] break-words">{value ?? "—"}</div>
    </div>
  );
}

function Chips({ values, empty = "None" }: { values: string[] | undefined; empty?: string }) {
  if (!values?.length) return <span className="text-xs text-[var(--color-text-muted)]">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <span key={value} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px]">
          {value}
        </span>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-[var(--color-border)] p-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h3>
      {children}
    </section>
  );
}

export function HistoricalUsageView({ usage }: { usage: HistoricalUsageEvidence }) {
  const fields: Array<[string, number | undefined]> = [
    ["Occurrences", usage.occurrences],
    ["Quantity", usage.quantity],
    ["Projects", usage.projects],
    ["Rooms", usage.rooms],
    ["Completed projects", usage.completedProjects],
    ["Priority score", usage.priorityScore],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {fields.map(([label, value]) => <Field key={label} label={label} value={value} />)}
    </div>
  );
}

function relatedLabel(ref: RelatedTemplateRef): string {
  return [ref.manufacturer, ref.modelNumber || ref.label].filter(Boolean).join(" ") || ref.id || "Unknown template";
}

function RefList({ values, empty = "None" }: { values: RelatedTemplateRef[]; empty?: string }) {
  if (!values.length) return <div className="text-xs text-[var(--color-text-muted)]">{empty}</div>;
  return (
    <ul className="space-y-1 text-xs">
      {values.map((value, index) => (
        <li key={value.id ?? `${relatedLabel(value)}-${index}`}>
          {relatedLabel(value)}{value.reason ? <span className="text-[var(--color-text-muted)]"> · {value.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function CollisionChecksView({ checks }: { checks: DuplicateCheck }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div><div className="mb-1 text-[10px] font-medium text-rose-800">Exact canonical collisions (blocker)</div><RefList values={checks.exactCanonicalCollisions} /></div>
      <div><div className="mb-1 text-[10px] font-medium text-rose-800">Exact alias collisions</div><RefList values={checks.exactAliasCollisions} /></div>
      <div><div className="mb-1 text-[10px] font-medium text-amber-800">Search-term overlaps (non-authoritative)</div><RefList values={checks.searchTermCollisions} /></div>
      <div><div className="mb-1 text-[10px] font-medium text-[var(--color-text-heading)]">Possible related templates (non-authoritative)</div><RefList values={checks.possibleRelatedTemplates} /></div>
    </div>
  );
}

export function TaxonomyValidationView({ results }: { results: TaxonomyValidationResult[] }) {
  if (!results.length) return <div className="text-xs text-[var(--color-text-muted)]">No taxonomy validation results</div>;
  return (
    <div className="space-y-2">
      {results.map((result, index) => (
        <div key={`${result.kind}-${index}`} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-xs">
          <span className="font-medium">{result.kind}</span>
          <div>
            <div>{result.values.length ? result.values.join(", ") : "None"}</div>
            {result.unknownValues.length > 0 && (
              <div className="text-amber-800">Unknown: {result.unknownValues.join(", ")}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProposedTemplatePropertiesDialog({
  value,
  evidenceRefs,
  rationale,
  onClose,
}: ProposedTemplatePropertiesDialogProps) {
  const { proposedTemplate: template, proposalMetadata: metadata } = value;
  const referenceUrl = safeUrl(template.referenceUrl);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposed-template-properties-title"
        className="flex max-h-[90vh] w-[min(760px,94vw)] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h2 id="proposed-template-properties-title" className="text-sm font-semibold text-[var(--color-text-heading)]">
            Proposed Template Properties
          </h2>
        </div>
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-[11px] text-amber-950">
          <strong>PROPOSED TEMPLATE — NOT APPLIED</strong>
          <div>Accepting records review approval only. It does not create or modify a canonical device template.</div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <Section title="Identity">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Manufacturer" value={template.manufacturer} />
              <Field label="Model number" value={template.modelNumber} />
              <Field label="Label" value={template.label} />
              <Field label="Short name" value={template.shortName} />
              <Field label="Category" value={template.category} />
              <Field label="Device type" value={template.deviceType} />
            </div>
          </Section>
          <Section title={`Ports (${template.ports.length})`}>
            {template.ports.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)]">No ports</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                    <tr><th className="pb-1 pr-2">Label</th><th className="pb-1 pr-2">Direction</th><th className="pb-1 pr-2">Signal</th><th className="pb-1 pr-2">Connector</th><th className="pb-1">Section</th></tr>
                  </thead>
                  <tbody>
                    {template.ports.map((port) => (
                      <tr key={port.id} className="border-t border-[var(--color-border)]">
                        <td className="py-1.5 pr-2 font-medium">{port.label}</td><td className="py-1.5 pr-2">{port.direction}</td><td className="py-1.5 pr-2">{port.signalType}</td><td className="py-1.5 pr-2">{port.connectorType ?? "—"}</td><td className="py-1.5">{port.section ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title="Classification">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><div className="mb-1 text-[10px] uppercase text-[var(--color-text-muted)]">Role tags</div><Chips values={template.roleTags} /></div>
              <div><div className="mb-1 text-[10px] uppercase text-[var(--color-text-muted)]">Device capabilities</div><Chips values={template.deviceCapabilities} /></div>
              <div><div className="mb-1 text-[10px] uppercase text-[var(--color-text-muted)]">Protocols</div><Chips values={template.protocols} /></div>
              <Field label="Rack form" value={template.rackForm} />
            </div>
          </Section>
          <Section title="Physical dimensions">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Height" value={template.heightMm != null ? `${template.heightMm} mm` : undefined} />
              <Field label="Width" value={template.widthMm != null ? `${template.widthMm} mm` : undefined} />
              <Field label="Depth" value={template.depthMm != null ? `${template.depthMm} mm` : undefined} />
              <Field label="Weight" value={template.weightKg != null ? `${template.weightKg} kg` : undefined} />
            </div>
          </Section>
          <Section title="Search and reference">
            <div className="space-y-2">
              <Chips values={template.searchTerms} empty="No search terms" />
              {referenceUrl ? <a href={referenceUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-700 underline">{template.referenceUrl}</a> : <Field label="Reference URL" value={template.referenceUrl} />}
            </div>
          </Section>
          <Section title="Identity aliases"><Chips values={metadata.identityAliases} /></Section>
          <Section title="Historical usage"><HistoricalUsageView usage={metadata.historicalUsageEvidence} /></Section>
          <Section title="Collision checks / related templates"><CollisionChecksView checks={metadata.duplicateCheck} /></Section>
          <Section title="Taxonomy validation"><TaxonomyValidationView results={metadata.taxonomyValidation} /></Section>
          <Section title="Operational notes">
            {metadata.operationalNotes.length ? <ul className="list-disc space-y-1 pl-5 text-xs">{metadata.operationalNotes.map((note) => <li key={note}>{note}</li>)}</ul> : <div className="text-xs text-[var(--color-text-muted)]">None</div>}
          </Section>
          <Section title="Evidence">
            {evidenceRefs.length ? <ul className="space-y-2 text-xs">{evidenceRefs.map((ref, index) => { const url = safeUrl(ref.url); return <li key={`${ref.type}-${index}`}><div className="font-medium">{ref.title ?? ref.type}</div>{ref.note && <div className="text-[var(--color-text-muted)]">{ref.note}</div>}{url && <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 underline">{ref.url}</a>}</li>; })}</ul> : <div className="text-xs text-[var(--color-text-muted)]">No evidence refs</div>}
          </Section>
          {rationale && <Section title="Rationale"><p className="text-xs">{rationale}</p></Section>}
        </div>
        <div className="flex justify-end border-t border-[var(--color-border)] px-4 py-3">
          <button type="button" onClick={onClose} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]">Close</button>
        </div>
      </div>
    </div>
  );
}
