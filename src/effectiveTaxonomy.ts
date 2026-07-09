import { useEffect, useMemo, useState } from "react";
import {
  ALL_CATEGORIES,
  DEVICE_TYPE_LABELS,
  DEVICE_TYPE_TO_CATEGORY,
} from "./deviceTypeCategories";
import { fetchTaxonomyRegistry, type TaxonomyRegistryValue } from "./tatesideApi";

export type EffectiveTaxonomySource = "dynamic" | "static-fallback";
export type EffectiveTaxonomyStatus = "active" | "deprecated";

export interface TaxonomyValue {
  value: string;
  label: string;
  status: EffectiveTaxonomyStatus;
}

export interface TaxonomyCategory extends TaxonomyValue {}

export interface TaxonomyDeviceType extends TaxonomyValue {
  parentValue: string;
}

export interface EffectiveTaxonomy {
  categories: TaxonomyCategory[];
  deviceTypes: TaxonomyDeviceType[];
  roleTags: TaxonomyValue[];
  deviceCapabilities: TaxonomyValue[];
  protocols: TaxonomyValue[];
  source: EffectiveTaxonomySource;
}

export interface EffectiveTaxonomyState {
  taxonomy: EffectiveTaxonomy;
  loading: boolean;
  error: Error | null;
}

function titleCaseKebab(value: string): string {
  if (/^[A-Z0-9]+$/.test(value)) return value;
  return value
    .split("-")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (["ptz", "ccu", "da", "tv", "ndi", "dsp", "kvm", "led", "nas", "usb", "hdmi"].includes(lower)) return lower.toUpperCase();
      if (lower === "av") return "AV";
      if (lower === "ip") return "IP";
      if (lower === "wifi") return "Wi-Fi";
      if (lower === "hdbaset") return "HDBaseT";
      if (lower === "iem") return "IEM";
      if (lower === "dmx") return "DMX";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function cleanLabel(value: string, label: string | null | undefined): string {
  return label?.trim() || titleCaseKebab(value);
}

function sortValues<T extends TaxonomyValue>(values: T[]): T[] {
  return [...values].sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

export function buildStaticEffectiveTaxonomy(): EffectiveTaxonomy {
  return {
    categories: ALL_CATEGORIES.map((value) => ({ value, label: value, status: "active" })),
    deviceTypes: sortValues(Object.entries(DEVICE_TYPE_TO_CATEGORY).map(([value, parentValue]) => ({
      value,
      label: DEVICE_TYPE_LABELS[value] ?? titleCaseKebab(value),
      parentValue,
      status: "active" as const,
    }))),
    roleTags: [],
    deviceCapabilities: [],
    protocols: [],
    source: "static-fallback",
  };
}

export const STATIC_EFFECTIVE_TAXONOMY = buildStaticEffectiveTaxonomy();

function normalizeValues(values: TaxonomyRegistryValue[], kind: TaxonomyRegistryValue["kind"]): TaxonomyValue[] {
  return sortValues(values
    .filter((value) => value.kind === kind && value.value.trim())
    .map((value) => ({
      value: value.value,
      label: cleanLabel(value.value, value.label),
      status: value.status,
    })));
}

export function buildDynamicEffectiveTaxonomy(values: TaxonomyRegistryValue[]): EffectiveTaxonomy | null {
  if (!Array.isArray(values)) return null;
  const categories = normalizeValues(values, "category");
  const deviceTypes = sortValues(values
    .filter((value) => value.kind === "deviceType" && value.value.trim() && value.parentValue?.trim())
    .map((value) => ({
      value: value.value,
      label: cleanLabel(value.value, value.label),
      parentValue: value.parentValue!,
      status: value.status,
    })));

  if (categories.length === 0 || deviceTypes.length === 0) return null;

  return {
    categories,
    deviceTypes,
    roleTags: normalizeValues(values, "roleTag"),
    deviceCapabilities: normalizeValues(values, "deviceCapability"),
    protocols: normalizeValues(values, "protocol"),
    source: "dynamic",
  };
}

export function activeCategories(taxonomy: EffectiveTaxonomy): TaxonomyCategory[] {
  return taxonomy.categories.filter((category) => category.status === "active");
}

export function activeDeviceTypes(taxonomy: EffectiveTaxonomy): TaxonomyDeviceType[] {
  return taxonomy.deviceTypes.filter((deviceType) => deviceType.status === "active");
}

export function deviceTypeLabel(taxonomy: EffectiveTaxonomy, value: string): string {
  return taxonomy.deviceTypes.find((deviceType) => deviceType.value === value)?.label
    ?? DEVICE_TYPE_LABELS[value]
    ?? titleCaseKebab(value);
}

export function categoryOptionsForCurrent(
  taxonomy: EffectiveTaxonomy,
  currentValue: string,
  customCategories: string[] = [],
): TaxonomyCategory[] {
  const byValue = new Map<string, TaxonomyCategory>();
  for (const category of activeCategories(taxonomy)) byValue.set(category.value, category);
  for (const value of customCategories) {
    const trimmed = value.trim();
    if (trimmed && !byValue.has(trimmed)) byValue.set(trimmed, { value: trimmed, label: trimmed, status: "active" });
  }

  const current = currentValue.trim();
  if (current && !byValue.has(current)) {
    const stored = taxonomy.categories.find((category) => category.value === current);
    byValue.set(current, stored ?? { value: current, label: current, status: "active" });
  }

  return sortValues([...byValue.values()]);
}

export function useEffectiveTaxonomy(): EffectiveTaxonomyState {
  const [dynamicTaxonomy, setDynamicTaxonomy] = useState<EffectiveTaxonomy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchTaxonomyRegistry()
      .then((response) => {
        if (cancelled) return;
        const taxonomy = buildDynamicEffectiveTaxonomy(response.values);
        if (taxonomy) {
          setDynamicTaxonomy(taxonomy);
          setError(null);
        } else {
          setDynamicTaxonomy(null);
          setError(new Error("Dynamic taxonomy registry response was empty or malformed"));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setDynamicTaxonomy(null);
        setError(err instanceof Error ? err : new Error("Dynamic taxonomy registry unavailable"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const taxonomy = useMemo(() => dynamicTaxonomy ?? STATIC_EFFECTIVE_TAXONOMY, [dynamicTaxonomy]);
  return { taxonomy, loading, error };
}
