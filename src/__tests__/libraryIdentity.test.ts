import { describe, expect, it } from "vitest";
import type { DeviceTemplate } from "../types";
import {
  buildLibraryIdentityIndex,
  normalizedLookupKey,
  resolveLibraryIdentity,
  uniqueIdentityMatchReason,
} from "../../tateside-api/src/libraryIdentity.ts";

function template(overrides: Partial<DeviceTemplate> & Pick<DeviceTemplate, "label" | "deviceType">): DeviceTemplate {
  return {
    ports: [],
    category: "Sources",
    ...overrides,
  };
}

describe("libraryIdentity", () => {
  it("returns unique for an explicit identity alias", () => {
    const a40 = template({
      id: "yealink-a40",
      label: "MeetingBar A40 All-in-One Video Bar",
      manufacturer: "Yealink",
      modelNumber: "MeetingBar A40",
      deviceType: "video-bar",
      identityAliases: ["A40-031"],
      searchTerms: ["4k", "Teams", "video bar"],
    });
    const index = buildLibraryIdentityIndex([a40]);
    const result = resolveLibraryIdentity(index, "Yealink", "A40-031");
    expect(result.kind).toBe("unique");
    if (result.kind === "unique") {
      expect(result.template.id).toBe("yealink-a40");
      expect(result.sources).toContain("identity-alias");
      expect(uniqueIdentityMatchReason(result.sources)).toMatch(/identity alias/i);
    }
  });

  it("returns unique for a reviewed manufacturer equivalent", () => {
    const core = template({
      id: "qsys-core-24f",
      label: "Core 24f Processor",
      manufacturer: "Q-SYS",
      modelNumber: "Core 24f",
      deviceType: "audio-dsp",
    });
    const index = buildLibraryIdentityIndex([core]);
    const result = resolveLibraryIdentity(index, "QSC", "Core 24f");
    expect(result.kind).toBe("unique");
    if (result.kind === "unique") {
      expect(result.template.id).toBe("qsys-core-24f");
      expect(result.sources).toContain("manufacturer-alias");
    }
  });

  it("returns unique for manufacturer equivalent plus identity alias", () => {
    const dm5c = template({
      id: "bose-dm5c",
      label: "DesignMax DM5C",
      manufacturer: "Bose Professional",
      modelNumber: "DM5C",
      deviceType: "speaker",
      identityAliases: ["DM5C-PAIR"],
    });
    const index = buildLibraryIdentityIndex([dm5c]);
    const byModel = resolveLibraryIdentity(index, "Bose", "DM5C");
    expect(byModel.kind).toBe("unique");
    if (byModel.kind === "unique") expect(byModel.template.id).toBe("bose-dm5c");

    const byAlias = resolveLibraryIdentity(index, "Bose", "DM5C-PAIR");
    expect(byAlias.kind).toBe("unique");
    if (byAlias.kind === "unique") expect(byAlias.template.id).toBe("bose-dm5c");
  });

  it("returns ambiguous when two templates share an identity alias", () => {
    const left = template({
      id: "left",
      label: "Left Device",
      manufacturer: "Acme",
      modelNumber: "LEFT",
      deviceType: "camera",
      identityAliases: ["SHARED-SKU"],
    });
    const right = template({
      id: "right",
      label: "Right Device",
      manufacturer: "Acme",
      modelNumber: "RIGHT",
      deviceType: "camera",
      identityAliases: ["SHARED-SKU"],
    });
    const index = buildLibraryIdentityIndex([left, right]);
    const result = resolveLibraryIdentity(index, "Acme", "SHARED-SKU");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.templates.map((t) => t.id).sort()).toEqual(["left", "right"]);
    }
  });

  it("returns ambiguous when two canonical templates share a normalized identity", () => {
    const a = template({
      id: "a",
      label: "Cam A",
      manufacturer: "Acme",
      modelNumber: "CAM-1",
      deviceType: "camera",
    });
    const b = template({
      id: "b",
      label: "Cam B",
      manufacturer: "Acme",
      modelNumber: "CAM 1",
      deviceType: "camera",
    });
    expect(normalizedLookupKey("Acme", "CAM-1")).toBe(normalizedLookupKey("Acme", "CAM 1"));
    const index = buildLibraryIdentityIndex([a, b]);
    const result = resolveLibraryIdentity(index, "Acme", "CAM-1");
    expect(result.kind).toBe("ambiguous");
  });

  it("counts one template reached through several keys as a single unique hit", () => {
    const tpl = template({
      id: "one",
      label: "MeetingBar A40 All-in-One",
      manufacturer: "Yealink",
      modelNumber: "MeetingBar A40",
      deviceType: "video-bar",
      identityAliases: ["A40-031", "MeetingBar A40"],
    });
    const index = buildLibraryIdentityIndex([tpl]);
    for (const model of ["MeetingBar A40", "MeetingBar A40 All-in-One", "A40-031"]) {
      const result = resolveLibraryIdentity(index, "Yealink", model);
      expect(result.kind).toBe("unique");
      if (result.kind === "unique") expect(result.template.id).toBe("one");
    }
  });

  it("does not treat noisy searchTerms as identity hits", () => {
    const tpl = template({
      id: "display",
      label: "Pro Display",
      manufacturer: "Acme",
      modelNumber: "PD-1",
      deviceType: "display",
      searchTerms: ["4k", "12g", "20x20", "48MP", "100V", "Teams"],
    });
    const index = buildLibraryIdentityIndex([tpl]);
    for (const noise of ["4k", "12g", "20x20", "48MP", "100V", "Teams"]) {
      expect(resolveLibraryIdentity(index, "Acme", noise).kind).toBe("none");
    }
  });

  it("returns none for empty manufacturer or model", () => {
    const tpl = template({
      id: "x",
      label: "X",
      manufacturer: "Acme",
      modelNumber: "X1",
      deviceType: "camera",
    });
    const index = buildLibraryIdentityIndex([tpl]);
    expect(resolveLibraryIdentity(index, "", "X1").kind).toBe("none");
    expect(resolveLibraryIdentity(index, "Acme", "").kind).toBe("none");
    expect(resolveLibraryIdentity(index, null, "X1").kind).toBe("none");
  });
});
