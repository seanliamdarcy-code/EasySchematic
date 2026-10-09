import type { DatabaseSync } from "node:sqlite";
import { getLibraryDoctorProposal, listLibraryDoctorProposalHistory, LibraryDoctorStoreError } from "./libraryDoctorStore.js";
import { validateTemplate } from "./libraryDoctorNewTemplate.js";
import { listCurrentTemplates, saveTemplates } from "./deviceStore.js";

export function publishApprovedNewTemplate(db: DatabaseSync, proposalId: string, actorEmail: string) {
  const proposal = getLibraryDoctorProposal(db, proposalId);
  if (proposal.proposalType !== "new-template" || proposal.status !== "accepted") {
    throw new LibraryDoctorStoreError(409, "Only an accepted new-device proposal can be published");
  }
  const templates = listCurrentTemplates(db);
  const published = listLibraryDoctorProposalHistory(db, proposalId).find((event) => event.details.action === "published");
  if (published) {
    const template = templates.find((item) => item.id === published.details.templateId);
    if (!template) throw new LibraryDoctorStoreError(409, "Previously published device is no longer active");
    return { template, alreadyPublished: true };
  }
  const value = proposal.proposedValue as { proposedTemplate?: unknown; proposalMetadata?: { identityAliases?: string[] } };
  const validation = validateTemplate(db, value?.proposedTemplate);
  if (!validation.proposedTemplate || validation.issues.length) {
    throw new LibraryDoctorStoreError(409, `Proposal is no longer valid: ${validation.issues.join("; ")}`);
  }
  const template = validation.proposedTemplate;
  const normalize = (text: string | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases = value.proposalMetadata?.identityAliases ?? [];
  if (templates.some((existing) => normalize(existing.manufacturer) === normalize(template.manufacturer)
    && [existing.modelNumber, existing.label, ...(existing.identityAliases ?? [])].some((identity) =>
      [template.modelNumber, ...aliases].some((candidate) => normalize(identity) === normalize(candidate))))) {
    throw new LibraryDoctorStoreError(409, "A matching device or identity alias already exists; review it instead of publishing a duplicate");
  }
  const [saved] = saveTemplates(db, { templates: [{ ...template, identityAliases: aliases,
    reviewStatus: "human-reviewed", classificationConfidence: proposal.confidence, evidenceRefs: proposal.evidenceRefs }],
    actorEmail, source: "library-doctor-approved", note: `Approved proposal ${proposalId}`,
    publicationProposalId: proposalId });
  return { template: saved, alreadyPublished: false };
}
