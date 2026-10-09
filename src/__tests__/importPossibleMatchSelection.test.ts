import { describe, expect, it } from "vitest";
import {
  resolveSelectedPossibleMatch,
  type QuoteImportCandidateMatch,
  type QuoteImportResultItem,
} from "../quoteImportTypes";

function candidate(id: string, label: string): QuoteImportCandidateMatch {
  return {
    id,
    label,
    manufacturer: "Acme",
    modelNumber: id,
    normalizedLookupKey: `acme::${id}`,
    matchReason: "Ambiguous library identity",
  };
}

describe("import possible-match selection", () => {
  const item: QuoteImportResultItem = {
    manufacturer: "Acme",
    model: "SHARED",
    description: null,
    quantity: 1,
    sourceLineText: null,
    normalizedLookupKey: "acme::shared",
    status: "possible_match",
    exactMatch: null,
    possibleMatches: [candidate("first", "First Device"), candidate("second", "Second Device")],
    portReuseCandidates: [],
  };

  it("starts the schematic with the second candidate when selected, not possibleMatches[0]", () => {
    const selected = resolveSelectedPossibleMatch(item, { kind: "use_library_match", templateId: "second" });
    expect(selected?.id).toBe("second");
    expect(selected?.id).not.toBe(item.possibleMatches[0]?.id);
  });

  it("clears library selection when researching as missing", () => {
    const selected = resolveSelectedPossibleMatch(item, { kind: "research_missing" });
    expect(selected).toBeNull();
  });

  it("returns null when the stored candidate id is no longer present", () => {
    const selected = resolveSelectedPossibleMatch(item, { kind: "use_library_match", templateId: "gone" });
    expect(selected).toBeNull();
  });
});
