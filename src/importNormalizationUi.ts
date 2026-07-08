import { TatesideApiError } from "./tatesideApi";

export interface ImportNormalizationUiMode {
  useSharedNormalization: boolean;
  useLegacyFallback: boolean;
  message: string | null;
}

export function getImportNormalizationUiMode(
  featureEnabled: boolean,
  error: unknown,
): ImportNormalizationUiMode {
  if (!featureEnabled) {
    return {
      useSharedNormalization: false,
      useLegacyFallback: true,
      message: null,
    };
  }

  if (error instanceof TatesideApiError && error.status === 404) {
    return {
      useSharedNormalization: false,
      useLegacyFallback: true,
      message: "Shared import normalization is enabled in the frontend, but disabled on the TateSide API for this environment. Falling back to local import controls.",
    };
  }

  return {
    useSharedNormalization: true,
    useLegacyFallback: false,
    message: error instanceof Error ? error.message : null,
  };
}
