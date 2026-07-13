import { describe, expect, it } from "vitest";
import {
  availableLibraryDoctorReviewActions,
  buildLibraryDoctorEnqueueBody,
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
import { TatesideApiError } from "../tatesideApi";
import {
  adaptTemplateForProposalPreview,
  parseNewTemplateProposalValue,
} from "../libraryDoctorProposalPreview";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProposedTemplatePropertiesDialog from "../components/ProposedTemplatePropertiesDialog";

const here = path.dirname(fileURLToPath(import.meta.url));

const neatProposalValue = {
  proposedTemplate: {
    manufacturer: "Neat",
    modelNumber: "Neat Center",
    label: "Neat Center",
    shortName: "Center",
    category: "Sources",
    deviceType: "camera",
    roleTags: ["future-taxonomy-value"],
    deviceCapabilities: ["poe-powered"],
    ports: [
      { id: "ethernet-poe", label: "PoE / Ethernet", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45", section: "Network / Power" },
      { id: "usb-c-debug", label: "USB-C Debug Only", signalType: "usb", direction: "bidirectional", connectorType: "usb-c", section: "Service" },
    ],
  },
  proposalMetadata: {
    identityAliases: ["NEATCENTER-SE"],
    historicalUsageEvidence: { occurrences: 7, quantity: 7, projects: 1, rooms: 7, completedProjects: 1, priorityScore: 62.5 },
    operationalNotes: ["USB-C is debug only."],
    duplicateCheck: { exactCanonicalCollisions: [], exactAliasCollisions: [], possibleRelatedTemplates: [], searchTermCollisions: [] },
    taxonomyValidation: [{ kind: "roleTag", values: ["future-taxonomy-value"], unknownValues: ["future-taxonomy-value"] }],
  },
};

describe("libraryDoctorUi helpers", () => {
  it("formats values for review display without mutation", () => {
    expect(formatLibraryDoctorValue(null)).toBe("(null)");
    expect(formatLibraryDoctorValue("euroblock")).toBe("euroblock");
    expect(formatLibraryDoctorValue(["dsp", "network-audio"])).toContain("dsp");
  });

  it("exposes only queue review actions — never apply", () => {
    expect(availableLibraryDoctorReviewActions("pending")).toEqual([
      "accepted",
      "rejected",
      "needs-manual-review",
    ]);
    expect(availableLibraryDoctorReviewActions("needs-manual-review")).toEqual([
      "accepted",
      "rejected",
      "pending",
    ]);
    expect(availableLibraryDoctorReviewActions("accepted")).toEqual([]);
    expect(availableLibraryDoctorReviewActions("rejected")).toEqual([]);
    expect(availableLibraryDoctorReviewActions("superseded")).toEqual([]);
    expect(libraryDoctorUiHasApplyAction()).toBe(false);
    expect(libraryDoctorReviewActionLabel("accepted")).toMatch(/queue only/i);
    expect(libraryDoctorStatusLabel("accepted")).toMatch(/queue only/i);
  });

  it("parses scope lists and summarizes identity", () => {
    expect(parseCommaSeparatedList("connectorType, direction")).toEqual([
      "connectorType",
      "direction",
    ]);
    expect(parseCommaSeparatedList("  ")).toBeUndefined();
    expect(
      summarizeProposalIdentity({
        manufacturer: "QSC",
        modelNumber: "SPA2-60",
        templateId: "abc",
      }),
    ).toBe("QSC SPA2-60");
    expect(
      summarizeProposalIdentity({
        manufacturer: null,
        modelNumber: null,
        templateId: "tmpl-1",
      }),
    ).toBe("tmpl-1");
  });

  it("requires meaningful generation scope and only enqueues candidateKeys", () => {
    expect(hasMeaningfulLibraryDoctorGenerationScope({})).toBe(false);
    expect(hasMeaningfulLibraryDoctorGenerationScope({ manufacturer: "QSC" })).toBe(true);
    expect(hasMeaningfulLibraryDoctorGenerationScope({ fields: ["connectorType"] })).toBe(true);
    const body = buildLibraryDoctorEnqueueBody(["abc", "def"]);
    expect(body).toEqual({ candidateKeys: ["abc", "def"] });
    expect(Object.keys(body)).toEqual(["candidateKeys"]);
    expect(body).not.toHaveProperty("proposedValue");
    expect(body).not.toHaveProperty("proposedValues");
  });

  it("classifies feature-flag 404s calmly for queue vs generation", () => {
    const queueDisabled = classifyLibraryDoctorFeatureError(
      new TatesideApiError("Library Doctor is not enabled", 404),
      "queue",
    );
    expect(queueDisabled.kind).toBe("disabled");
    expect(queueDisabled.message).toMatch(/TATESIDE_LIBRARY_DOCTOR_ENABLED/);

    const genDisabled = classifyLibraryDoctorFeatureError(
      new TatesideApiError("Library Doctor generation is not enabled", 404),
      "generation",
    );
    expect(genDisabled.kind).toBe("disabled");
    expect(genDisabled.message).toMatch(/GENERATION_ENABLED/);
    expect(genDisabled.message).toMatch(/Review Queue may still work/i);

    const other = classifyLibraryDoctorFeatureError(new Error("Network timeout"), "queue");
    expect(other.kind).toBe("other");
    expect(other.message).toBe("Network timeout");
  });

  it("formats structured enqueue summaries", () => {
    expect(
      formatLibraryDoctorEnqueueSummary({
        requested: 3,
        created: 1,
        alreadyExisting: 1,
        staleOrMissing: 1,
        rejectedHighRisk: 0,
        proposalIds: ["p1"],
        existing: [],
        createdProposals: [],
      }),
    ).toMatch(/Created: 1/);
  });

  it("safely parses the actual new-template proposal shape", () => {
    const parsed = parseNewTemplateProposalValue(neatProposalValue);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proposedTemplate.label).toBe("Neat Center");
    expect(parsed.value.proposedTemplate.ports.map((port) => port.label)).toEqual([
      "PoE / Ethernet",
      "USB-C Debug Only",
    ]);
    expect(parsed.value.proposedTemplate.roleTags).toEqual(["future-taxonomy-value"]);
    expect(parsed.value.proposalMetadata.historicalUsageEvidence.rooms).toBe(7);
  });

  it("rejects malformed new-template values without inventing a device", () => {
    expect(parseNewTemplateProposalValue(null).ok).toBe(false);
    expect(parseNewTemplateProposalValue({}).ok).toBe(false);
    expect(parseNewTemplateProposalValue({ ...neatProposalValue, proposedTemplate: { ...neatProposalValue.proposedTemplate, label: "" } }).ok).toBe(false);
    expect(parseNewTemplateProposalValue({ ...neatProposalValue, proposedTemplate: { ...neatProposalValue.proposedTemplate, ports: [{}] } }).ok).toBe(false);
  });

  it("builds a complete, full-label, store-independent preview", () => {
    const parsed = parseNewTemplateProposalValue(neatProposalValue);
    if (!parsed.ok) throw new Error(parsed.error);
    const adapted = adaptTemplateForProposalPreview(parsed.value.proposedTemplate);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.data.label).toBe("Neat Center");
    expect(adapted.data.ports).toHaveLength(2);
    expect(adapted.data).not.toHaveProperty("templateId");
    expect(adapted.data).not.toHaveProperty("templateVersion");
    expect(adapted.data).not.toHaveProperty("id");
  });

  it("allows missing optional dimensions and rejects invalid adapter input", () => {
    const parsed = parseNewTemplateProposalValue(neatProposalValue);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(adaptTemplateForProposalPreview(parsed.value.proposedTemplate).ok).toBe(true);
    expect(adaptTemplateForProposalPreview({ ...parsed.value.proposedTemplate, label: "" }).ok).toBe(false);
  });

  it("renders complete proposed-template properties with Close as the only action", () => {
    const value = structuredClone(neatProposalValue);
    Object.assign(value.proposedTemplate, { heightMm: 297, widthMm: 84, depthMm: 84, weightKg: 1.47 });
    const parsed = parseNewTemplateProposalValue(value);
    if (!parsed.ok) throw new Error(parsed.error);
    const html = renderToStaticMarkup(createElement(ProposedTemplatePropertiesDialog, {
      value: parsed.value,
      evidenceRefs: [{ type: "official-product-page", title: "Neat Center", url: "https://neat.no/center/" }],
      rationale: "Canonical Neat Center is missing.",
      onClose: () => undefined,
    }));
    for (const text of ["Proposed Template Properties", "PROPOSED TEMPLATE — NOT APPLIED", "Neat Center", "PoE / Ethernet", "USB-C Debug Only", "297 mm", "NEATCENTER-SE", "Occurrences", "Collision checks", "Taxonomy validation", "USB-C is debug only.", "Canonical Neat Center is missing."]) {
      expect(html).toContain(text);
    }
    expect((html.match(/<button/g) ?? [])).toHaveLength(1);
    expect(html).toContain(">Close</button>");
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(html).not.toMatch(/>\s*(Save|Apply|Promote|Create|Delete)\b/i);
  });

  it("uses the shared block visual without schematic-store preview state", () => {
    const nodeSource = readFileSync(path.resolve(here, "../components/DeviceNode.tsx"), "utf8");
    const previewSource = readFileSync(path.resolve(here, "../components/ProposalDeviceBlockPreview.tsx"), "utf8");
    const visualSource = readFileSync(path.resolve(here, "../components/DeviceBlockVisual.tsx"), "utf8");
    expect(nodeSource).toMatch(/import DeviceBlockVisual/);
    expect(previewSource).toMatch(/import DeviceBlockVisual/);
    expect(previewSource).toMatch(/proposal-preview:\$\{proposalId\}/);
    expect(previewSource).toMatch(/draggable:\s*false/);
    expect(previewSource).toMatch(/connectable:\s*false/);
    expect(previewSource).toMatch(/selectable:\s*false/);
    expect(previewSource).not.toMatch(/useSchematicStore|addDevice|setEditingNodeId|localStorage/);
    expect(visualSource).not.toMatch(/useSchematicStore|setEditingNodeId/);
  });

  it("Library Doctor dialog source never defines an Apply control", () => {
    const dialogPath = path.resolve(here, "../components/LibraryDoctorDialog.tsx");
    const source = readFileSync(dialogPath, "utf8");
    expect(source).not.toMatch(/>\s*Apply\s*</);
    expect(source).not.toMatch(/handleApply/);
    expect(source).not.toMatch(/Fix library|Update templates|Correct library|Bulk apply|Auto-fix/i);
    expect(source).toMatch(/does not change the device template/i);
    expect(source).toMatch(/No Apply control is available by design/);
    expect(source).toMatch(/Add selected to review queue/);
    expect(source).toMatch(/Safe alias candidates preset/);
    expect(source).toMatch(/highRisk skip events/);
    expect(source).toMatch(/oldest → newest/);
    expect(source).toMatch(/Enqueue results/);
    expect(source).toMatch(/Open Review queue/);
    expect(source).toMatch(/Candidate generation is disabled/);
    expect(source).toMatch(/Review queue unavailable/);
    expect(source).toMatch(/never client proposed values/);
    expect(source).toMatch(/role="dialog"/);
    // Must not call template mutation APIs from the review UI surface.
    expect(source).not.toMatch(/updateTatesideDeviceTemplate/);
    expect(source).not.toMatch(/saveTatesideDeviceTemplates/);
    expect(source).not.toMatch(/bulkEditTatesideDeviceTemplates/);
  });

  it("API client has no library-doctor apply endpoint helper", () => {
    const apiPath = path.resolve(here, "../tatesideApi.ts");
    const source = readFileSync(apiPath, "utf8");
    expect(source).toMatch(/library-doctor\/generation\/preview/);
    expect(source).toMatch(/library-doctor\/generation\/enqueue/);
    expect(source).toMatch(/library-doctor\/proposals/);
    expect(source).not.toMatch(/library-doctor\/.*apply/);
    expect(source).toMatch(/Accepted does not apply/);
    // enqueue body is keys-only
    expect(source).toMatch(/body:\s*\{\s*candidateKeys\s*\}/);
  });
});
