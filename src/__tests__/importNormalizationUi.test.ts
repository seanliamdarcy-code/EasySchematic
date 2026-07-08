import { describe, expect, it } from "vitest";
import { TatesideApiError } from "../tatesideApi";
import {
  getDefaultImportNormalizationScope,
  getImportNormalizationUiMode,
  isImportDevicesSaveLockedByNormalization,
} from "../importNormalizationUi";

describe("getImportNormalizationUiMode", () => {
  it("falls back to legacy controls on exact feature-flag mismatch", () => {
    expect(getImportNormalizationUiMode(true, new TatesideApiError("Import normalization is not enabled", 404))).toEqual({
      useSharedNormalization: false,
      useLegacyFallback: true,
      message: "Shared import normalization is enabled in the frontend, but disabled on the TateSide API for this environment. Falling back to local import controls.",
    });
  });

  it("keeps shared mode active for non-mismatch errors", () => {
    expect(getImportNormalizationUiMode(true, new Error("Network timeout"))).toEqual({
      useSharedNormalization: true,
      useLegacyFallback: false,
      message: "Network timeout",
    });
  });

  it("defaults model-scoped review choices to model before manufacturer", () => {
    expect(getDefaultImportNormalizationScope("AIDA", "HD-NDI-200")).toBe("model");
    expect(getDefaultImportNormalizationScope("AIDA", undefined)).toBe("manufacturer");
    expect(getDefaultImportNormalizationScope(undefined, undefined)).toBe("global");
  });

  it("keeps save and import actions disabled while shared normalization is still resolving", () => {
    expect(isImportDevicesSaveLockedByNormalization(true, true, true, false)).toBe(true);
    expect(isImportDevicesSaveLockedByNormalization(true, true, false, false)).toBe(true);
    expect(isImportDevicesSaveLockedByNormalization(true, true, false, true)).toBe(false);
    expect(isImportDevicesSaveLockedByNormalization(false, true, true, false)).toBe(false);
    expect(isImportDevicesSaveLockedByNormalization(true, false, true, false)).toBe(false);
  });
});
