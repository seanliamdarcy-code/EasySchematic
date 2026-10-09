import type { DeviceTemplate } from "./types.js";

export type ImportNormalizationFieldKind = "connectorType" | "signalType" | "deviceType";
export type ImportNormalizationScope = "model" | "manufacturer" | "global";
export type ImportNormalizationTrustLevel = "draft" | "reviewed" | "trusted_standard";

export interface ImportNormalizationMetadata {
  rawSignalType?: string;
  rawConnectorType?: string;
  rawDeviceType?: string;
  appliedRuleIds?: string[];
  resolvedAt?: string;
}

export interface ImportNormalizationRule {
  id: string;
  fieldKind: ImportNormalizationFieldKind;
  rawValue: string;
  normalizedRawValue: string;
  manufacturer?: string;
  normalizedManufacturer?: string;
  modelNumber?: string;
  normalizedModelNumber?: string;
  canonicalValue: string;
  scope: ImportNormalizationScope;
  trustLevel: ImportNormalizationTrustLevel;
  source: string;
  notes?: string;
  createdAt: string;
  createdByEmail?: string | null;
  updatedAt: string;
  updatedByEmail?: string | null;
}

export interface ImportNormalizationDraftRule {
  fieldKind: ImportNormalizationFieldKind;
  rawValue: string;
  manufacturer?: string;
  modelNumber?: string;
  canonicalValue: string;
  scope: ImportNormalizationScope;
  trustLevel?: ImportNormalizationTrustLevel;
}

export interface ImportNormalizationAppliedRule {
  ruleId: string;
  fieldKind: ImportNormalizationFieldKind;
  rawValue: string;
  canonicalValue: string;
  scope: ImportNormalizationScope;
}

export interface ImportNormalizationAffectedPort {
  templateLabel: string;
  portLabel?: string;
}

export interface ImportNormalizationUnresolved {
  fieldKind: ImportNormalizationFieldKind;
  rawValue: string;
  manufacturer?: string;
  modelNumber?: string;
  affectedPorts: ImportNormalizationAffectedPort[];
}

export interface ImportNormalizationResolution {
  templates: DeviceTemplate[];
  appliedRules: ImportNormalizationAppliedRule[];
  unresolved: ImportNormalizationUnresolved[];
}

export interface ImportNormalizationResolveRequest {
  templates: DeviceTemplate[];
  draftRules?: ImportNormalizationDraftRule[];
}

export function normalizeImportNormalizationText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
