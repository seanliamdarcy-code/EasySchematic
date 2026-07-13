import { useMemo, useState } from "react";
import type { LibraryDoctorProposal } from "../tatesideApi";
import {
  adaptTemplateForProposalPreview,
  parseNewTemplateProposalValue,
} from "../libraryDoctorProposalPreview";
import ProposalDeviceBlockPreview from "./ProposalDeviceBlockPreview";
import ProposedTemplatePropertiesDialog, {
  CollisionChecksView,
  HistoricalUsageView,
  TaxonomyValidationView,
} from "./ProposedTemplatePropertiesDialog";

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-[var(--color-border)] p-2">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h3>
      {children}
    </section>
  );
}

export default function NewTemplateProposalDetail({ proposal }: { proposal: LibraryDoctorProposal }) {
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const parsed = useMemo(() => parseNewTemplateProposalValue(proposal.proposedValue), [proposal.proposedValue]);
  const adapted = useMemo(
    () => parsed.ok ? adaptTemplateForProposalPreview(parsed.value.proposedTemplate) : null,
    [parsed],
  );

  if (!parsed.ok) {
    return (
      <div className="rounded border border-rose-200 bg-rose-50 p-3 text-rose-900">
        <div className="font-semibold">Visual preview unavailable</div>
        <div className="mt-1 text-[10px]">{parsed.error} Inspect Raw proposal JSON below.</div>
      </div>
    );
  }
  if (!adapted || !adapted.ok) return (
    <div className="rounded border border-rose-200 bg-rose-50 p-3 text-rose-900">
      <div className="font-semibold">Visual preview unavailable</div>
      <div className="mt-1 text-[10px]">{adapted?.errors.join("; ") || "The proposed template is malformed."} Inspect Raw proposal JSON below.</div>
    </div>
  );

  const { proposalMetadata: metadata } = parsed.value;
  const openProperties = () => setPropertiesOpen(true);
  return (
    <>
      <div className="grid gap-2 lg:grid-cols-[minmax(0,0.7fr)_minmax(260px,1.3fr)]">
        <Section title="Current">
          <div className="flex min-h-24 items-center justify-center rounded bg-[var(--color-surface)] text-xs text-[var(--color-text-muted)]">
            No existing template
          </div>
        </Section>
        <Section title="Proposed template">
          <ProposalDeviceBlockPreview
            proposalId={proposal.id}
            data={adapted.data}
            onOpen={openProperties}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] text-[var(--color-text-muted)]">Double-click to inspect read-only properties</span>
            <button
              type="button"
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] hover:bg-[var(--color-surface-hover)]"
              onClick={openProperties}
            >
              Open read-only properties
            </button>
          </div>
        </Section>
      </div>

      <Section title="Historical usage">
        <HistoricalUsageView usage={metadata.historicalUsageEvidence} />
      </Section>
      <Section title="Collision checks and related templates">
        <CollisionChecksView checks={metadata.duplicateCheck} />
      </Section>
      <Section title="Taxonomy validation">
        <TaxonomyValidationView results={metadata.taxonomyValidation} />
      </Section>
      <Section title="Operational notes">
        {metadata.operationalNotes.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs">{metadata.operationalNotes.map((note) => <li key={note}>{note}</li>)}</ul>
        ) : <div className="text-xs text-[var(--color-text-muted)]">None</div>}
      </Section>
      <Section title="Evidence and rationale">
        {proposal.rationale && <p className="mb-2 text-xs">{proposal.rationale}</p>}
        {proposal.evidenceRefs.length ? (
          <ul className="space-y-2 text-xs">
            {proposal.evidenceRefs.map((ref, index) => {
              const url = safeUrl(ref.url);
              return (
                <li key={`${ref.type}-${index}`}>
                  <div className="font-medium">{ref.title ?? ref.type}</div>
                  {ref.note && <div className="text-[var(--color-text-muted)]">{ref.note}</div>}
                  {url && <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 underline">{ref.url}</a>}
                </li>
              );
            })}
          </ul>
        ) : <div className="text-xs text-[var(--color-text-muted)]">No evidence refs</div>}
      </Section>

      {propertiesOpen && (
        <ProposedTemplatePropertiesDialog
          value={parsed.value}
          evidenceRefs={proposal.evidenceRefs}
          rationale={proposal.rationale}
          onClose={() => setPropertiesOpen(false)}
        />
      )}
    </>
  );
}
