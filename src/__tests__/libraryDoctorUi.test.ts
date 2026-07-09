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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
