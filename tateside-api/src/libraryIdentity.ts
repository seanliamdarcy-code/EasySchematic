import type { DeviceTemplate } from "../../src/types.js";

/** Reviewed manufacturer equivalence groups (bidirectional). */
export const MANUFACTURER_EQUIVALENCE_GROUPS: readonly (readonly string[])[] = [
  ["QSC", "Q-SYS"],
  ["Bose", "Bose Professional"],
] as const;

export type IdentityMatchSource =
  | "canonical-model"
  | "canonical-label"
  | "identity-alias"
  | "manufacturer-alias";

export type LibraryIdentityResolution =
  | { kind: "none" }
  | { kind: "unique"; template: DeviceTemplate; sources: IdentityMatchSource[] }
  | { kind: "ambiguous"; templates: DeviceTemplate[]; sources: IdentityMatchSource[] };

interface IndexedHit {
  template: DeviceTemplate;
  sources: Set<IdentityMatchSource>;
}

export interface LibraryIdentityIndex {
  /** normalizedLookupKey -> hits deduped by stable template identity */
  readonly byKey: Map<string, Map<string, IndexedHit>>;
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Deterministic manufacturer+model identity key (same rule as historical quoteImport). */
export function normalizedLookupKey(manufacturer?: string | null, model?: string | null): string {
  const maker = normalizeToken(manufacturer);
  const modelToken = normalizeToken(model);
  if (maker && modelToken) return `${maker}::${modelToken}`;
  return maker || modelToken;
}

export function stableTemplateIdentity(template: DeviceTemplate): string {
  if (template.id) return template.id;
  return `${template.deviceType}:${template.label}`;
}

/** All manufacturer spellings equivalent to the given name, including itself when known. */
export function manufacturerEquivalents(manufacturer: string | null | undefined): string[] {
  const raw = (manufacturer ?? "").trim();
  if (!raw) return [];
  const key = normalizeToken(raw);
  for (const group of MANUFACTURER_EQUIVALENCE_GROUPS) {
    if (group.some((entry) => normalizeToken(entry) === key)) {
      return [...group];
    }
  }
  return [raw];
}

function addHit(
  byKey: Map<string, Map<string, IndexedHit>>,
  lookupKey: string | null | undefined,
  template: DeviceTemplate,
  source: IdentityMatchSource,
): void {
  if (!lookupKey) return;
  let bucket = byKey.get(lookupKey);
  if (!bucket) {
    bucket = new Map();
    byKey.set(lookupKey, bucket);
  }
  const identity = stableTemplateIdentity(template);
  const existing = bucket.get(identity);
  if (existing) {
    existing.sources.add(source);
    return;
  }
  bucket.set(identity, { template, sources: new Set([source]) });
}

/**
 * Build a shared identity index from current library templates.
 * Indexes canonical model/label and explicit identityAliases under each
 * manufacturer and its reviewed equivalents. Does not index searchTerms.
 */
export function buildLibraryIdentityIndex(templates: readonly DeviceTemplate[]): LibraryIdentityIndex {
  const byKey = new Map<string, Map<string, IndexedHit>>();

  for (const template of templates) {
    const ownManufacturer = (template.manufacturer ?? "").trim();
    const manufacturers = manufacturerEquivalents(ownManufacturer.length > 0 ? ownManufacturer : null);
    if (manufacturers.length === 0 && !ownManufacturer) {
      // No manufacturer: still allow model-only keys only when model present — skip; matching requires both.
      continue;
    }
    const ownKey = normalizeToken(ownManufacturer);

    for (const manufacturer of manufacturers) {
      const viaManufacturerAlias = normalizeToken(manufacturer) !== ownKey;
      const modelSource: IdentityMatchSource = viaManufacturerAlias ? "manufacturer-alias" : "canonical-model";
      const labelSource: IdentityMatchSource = viaManufacturerAlias ? "manufacturer-alias" : "canonical-label";
      const aliasSource: IdentityMatchSource = viaManufacturerAlias ? "manufacturer-alias" : "identity-alias";

      if (template.modelNumber?.trim()) {
        addHit(byKey, normalizedLookupKey(manufacturer, template.modelNumber), template, modelSource);
        if (template.label?.trim()) {
          addHit(byKey, normalizedLookupKey(manufacturer, template.label), template, labelSource);
        }
      } else if (template.label?.trim()) {
        // Preserve historical exact behaviour when modelNumber is absent.
        addHit(byKey, normalizedLookupKey(manufacturer, template.label), template, modelSource);
      }

      for (const alias of template.identityAliases ?? []) {
        if (!alias?.trim()) continue;
        addHit(byKey, normalizedLookupKey(manufacturer, alias), template, aliasSource);
      }
    }
  }

  return { byKey };
}

/**
 * Resolve a manufacturer+model pair against the identity index.
 * Unique hit → unique; multi-template hit → ambiguous; else none.
 * Never picks templates[0] for ambiguous results.
 */
export function resolveLibraryIdentity(
  index: LibraryIdentityIndex,
  manufacturer: string | null | undefined,
  model: string | null | undefined,
): LibraryIdentityResolution {
  const maker = normalizeToken(manufacturer);
  const modelToken = normalizeToken(model);
  if (!maker || !modelToken) return { kind: "none" };

  const key = normalizedLookupKey(manufacturer, model);
  const bucket = index.byKey.get(key);
  if (!bucket || bucket.size === 0) return { kind: "none" };

  const hits = [...bucket.values()];
  if (hits.length === 1) {
    return {
      kind: "unique",
      template: hits[0].template,
      sources: [...hits[0].sources],
    };
  }

  const sources = new Set<IdentityMatchSource>();
  for (const hit of hits) {
    for (const source of hit.sources) sources.add(source);
  }
  return {
    kind: "ambiguous",
    templates: hits.map((hit) => hit.template),
    sources: [...sources],
  };
}

/** Human matchReason for unique identity hits (quote import UI). */
export function uniqueIdentityMatchReason(sources: readonly IdentityMatchSource[]): string {
  const hasCanonical = sources.includes("canonical-model") || sources.includes("canonical-label");
  if (!hasCanonical && sources.includes("identity-alias")) {
    return "Reviewed identity alias match in TateSide library";
  }
  if (!hasCanonical && sources.includes("manufacturer-alias")) {
    return "Reviewed manufacturer alias match in TateSide library";
  }
  return "Exact manufacturer/model match in TateSide library";
}
