import { normalizedLookupKey } from "./quoteImport.js";

/**
 * Deterministic historical-line classification for Jetbuilt intelligence.
 * Derived only — never mutates source rows, templates, taxonomy, or Jetbuilt.
 */
export const JETBUILT_SCHEMATIC_RELEVANCE_VERSION = "jetbuilt-schematic-relevance-v1";

export type JetbuiltHistoryLineClass =
  | "labour-service"
  | "project-management"
  | "sundries"
  | "logistics"
  | "travel"
  | "annotation"
  | "unknown";

export interface JetbuiltHistoryLineClassificationResult {
  classificationVersion: string;
  class: JetbuiltHistoryLineClass;
  /** false = excluded from schematic-relevant fingerprints; null = unknown (included); true = known relevant */
  schematicRelevant: boolean | null;
  ruleId: string | null;
  reason: string | null;
}

interface ExactRule {
  class: Exclude<JetbuiltHistoryLineClass, "unknown">;
  schematicRelevant: false;
  ruleId: string;
  reason: string;
}

/**
 * Exact normalized manufacturer/model identity rules only.
 * Keys use the same deterministic normalization as quoteImport.normalizedLookupKey
 * (non-alphanumeric stripped, lowercased) so "Tateside" and "Tateside -" match equivalently.
 */
const EXACT_NON_SCHEMATIC_RULES: Readonly<Record<string, ExactRule>> = {
  "tateside::installation": {
    class: "labour-service",
    schematicRelevant: false,
    ruleId: "exact:tateside:installation",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::commissioning": {
    class: "labour-service",
    schematicRelevant: false,
    ruleId: "exact:tateside:commissioning",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::projectmanagement": {
    class: "project-management",
    schematicRelevant: false,
    ruleId: "exact:tateside:project-management",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::sundries": {
    class: "sundries",
    schematicRelevant: false,
    ruleId: "exact:tateside:sundries",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::generalfixingssundries": {
    class: "sundries",
    schematicRelevant: false,
    ruleId: "exact:tateside:general-fixings-sundries",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::programming": {
    class: "labour-service",
    schematicRelevant: false,
    ruleId: "exact:tateside:programming",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::engineeringresource": {
    class: "labour-service",
    schematicRelevant: false,
    ruleId: "exact:tateside:engineering-resource",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::shipping": {
    class: "logistics",
    schematicRelevant: false,
    ruleId: "exact:tateside:shipping",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "delivery::delivery": {
    class: "logistics",
    schematicRelevant: false,
    ruleId: "exact:delivery:delivery",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
  "tateside::travel": {
    class: "travel",
    schematicRelevant: false,
    ruleId: "exact:tateside:travel",
    reason: "Exact deterministic normalized manufacturer/model identity match",
  },
};

export function listJetbuiltSchematicRelevanceV1Rules(): Array<{
  normalizedIdentity: string;
  class: ExactRule["class"];
  schematicRelevant: false;
  ruleId: string;
  reason: string;
}> {
  return Object.entries(EXACT_NON_SCHEMATIC_RULES)
    .map(([normalizedIdentity, rule]) => ({
      normalizedIdentity,
      class: rule.class,
      schematicRelevant: false as const,
      ruleId: rule.ruleId,
      reason: rule.reason,
    }))
    .sort((a, b) => a.normalizedIdentity.localeCompare(b.normalizedIdentity) || a.ruleId.localeCompare(b.ruleId));
}

export function jetbuiltSchematicRelevanceV1RuleCount(): number {
  return Object.keys(EXACT_NON_SCHEMATIC_RULES).length;
}

/**
 * Classify a historical BOM line by exact normalized manufacturer/model identity.
 * Unknown remains unknown with schematicRelevant null (must not be silently excluded).
 * Does not use fuzzy matching, embeddings, AI, or broad substring exclusion rules.
 */
export function classifyJetbuiltHistoryLine(
  manufacturerRaw: string | null | undefined,
  modelRaw: string | null | undefined,
): JetbuiltHistoryLineClassificationResult {
  const key = normalizedLookupKey(manufacturerRaw, modelRaw);
  if (key && key.includes("::")) {
    const rule = EXACT_NON_SCHEMATIC_RULES[key];
    if (rule) {
      return {
        classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
        class: rule.class,
        schematicRelevant: rule.schematicRelevant,
        ruleId: rule.ruleId,
        reason: rule.reason,
      };
    }
  }
  return {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    class: "unknown",
    schematicRelevant: null,
    ruleId: null,
    reason: null,
  };
}

/** True when the line is retained in schematic-relevant fingerprints (unknown or known-relevant). */
export function isSchematicRelevantForFingerprint(result: JetbuiltHistoryLineClassificationResult): boolean {
  return result.schematicRelevant !== false;
}
