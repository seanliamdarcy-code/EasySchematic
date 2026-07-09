import { ALL_CATEGORIES, DEVICE_TYPE_TO_CATEGORY } from "../../src/deviceTypeCategories.js";
import type { DeviceTemplate } from "../../src/types.js";

export type TaxonomyRegistryField =
  | "category"
  | "deviceType"
  | "roleTags"
  | "deviceCapabilities"
  | "protocols"
  | "connectorType"
  | "signalType"
  | "direction";

export interface TaxonomyAliasEntry {
  field: TaxonomyRegistryField;
  canonicalValue: string;
  aliases: string[];
  deprecatedValues: string[];
  migrationRisk: "low" | "medium" | "high";
  notes?: string;
}

export interface TaxonomyStateValue {
  values: string[];
  unknownValues: string[];
}

export interface TaxonomyAliasMatch {
  field: TaxonomyRegistryField;
  inputValue: string;
  canonicalValue: string;
  migrationRisk: TaxonomyAliasEntry["migrationRisk"];
  deprecated: boolean;
  notes?: string;
}

export interface TaxonomyProposal {
  field: "category" | "roleTags" | "deviceCapabilities" | "protocols";
  value: string;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export interface TaxonomyVocabularies {
  categories: string[];
  deviceTypes: Array<{ value: string; category: string }>;
  roleTags: string[];
  deviceCapabilities: string[];
  protocols: string[];
}

export interface TaxonomyInspection {
  readOnly: true;
  template: {
    deviceType: string;
    category?: string;
    roleTags: TaxonomyStateValue;
    deviceCapabilities: TaxonomyStateValue;
    protocols: TaxonomyStateValue;
    reviewStatus?: DeviceTemplate["reviewStatus"];
    classificationConfidence?: DeviceTemplate["classificationConfidence"];
    evidenceRefCount: number;
    lastReviewedBy?: string;
    lastReviewedAt?: string;
  };
  aliasMatches: TaxonomyAliasMatch[];
  category: {
    expected?: string;
    matchesCanonical: boolean;
  };
  deviceType: {
    known: boolean;
  };
}

export interface TaxonomyPreview {
  readOnly: true;
  proposals: TaxonomyProposal[];
  aliasMatches: TaxonomyAliasMatch[];
}

const ROLE_TAGS = [
  "room-display",
  "room-compute",
  "mtr-compute",
  "ceiling-mic",
  "table-mic",
  "dsp",
  "aec",
  "amplifier",
  "network-audio",
  "signage",
  "conferencing",
  "programme-audio",
  "install-control",
  "paging",
  "wireless-presentation",
  "wall-plate",
  "avoip",
] as const;

const DEVICE_CAPABILITIES = [
  "audio-processing",
  "aec",
  "automixing",
  "amplification",
  "video-routing",
  "audio-routing",
  "encode-video",
  "decode-video",
  "usb-bridging",
  "serial-control",
  "gpio-control",
  "network-control",
  "poe-powered",
  "poe-source",
  "matrix-routing",
  "paging",
] as const;

const PROTOCOLS = [
  "dante",
  "aes67",
  "avb",
  "amplink",
  "q-lan",
  "ndi",
  "hdbaset",
  "voip",
  "pstn",
  "st2110",
  "srt",
  "rtsp",
  "rtmp",
  "artnet",
  "sacn",
] as const;

const TAXONOMY_ALIAS_ENTRIES: TaxonomyAliasEntry[] = [
  {
    field: "connectorType",
    canonicalValue: "combo-xlr-trs",
    aliases: ["xlr-trs-combo"],
    deprecatedValues: [],
    migrationRisk: "low",
    notes: "Legacy combo-jack spelling.",
  },
  {
    field: "connectorType",
    canonicalValue: "trs-eighth",
    aliases: ["3.5mm"],
    deprecatedValues: [],
    migrationRisk: "low",
    notes: "Usually safe for audio mini-jacks, but still review TS/TRRS nuance before writes.",
  },
  {
    field: "connectorType",
    canonicalValue: "barrel",
    aliases: ["dc-barrel"],
    deprecatedValues: [],
    migrationRisk: "low",
    notes: "Preserve source text; do not auto-rewrite yet.",
  },
  {
    field: "connectorType",
    canonicalValue: "terminal-block",
    aliases: ["euroblock"],
    deprecatedValues: ["phoenix"],
    migrationRisk: "high",
    notes: "Manufacturer conventions vary; review before any future migration.",
  },
  {
    field: "direction",
    canonicalValue: "bidirectional",
    aliases: ["inout"],
    deprecatedValues: [],
    migrationRisk: "low",
    notes: "Safe candidate for preview, still read-only in V2 foundation.",
  },
  {
    field: "deviceType",
    canonicalValue: "camera",
    aliases: ["camera-head"],
    deprecatedValues: [],
    migrationRisk: "medium",
    notes: "Existing import normalization already treats camera-head as a candidate, not a blind rewrite.",
  },
  {
    field: "roleTags",
    canonicalValue: "avoip",
    aliases: ["av-over-ip"],
    deprecatedValues: [],
    migrationRisk: "medium",
    notes: "Role tag only; do not change primary deviceType automatically.",
  },
] as const;

const DEVICE_TYPES = Object.entries(DEVICE_TYPE_TO_CATEGORY)
  .map(([value, category]) => ({ value, category }))
  .sort((a, b) => a.value.localeCompare(b.value));

function normalize(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function valueState(values: string[] | undefined, allowed: readonly string[]): TaxonomyStateValue {
  const canonicalSet = new Set(allowed);
  const seen = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  return {
    values: seen,
    unknownValues: seen.filter((value) => !canonicalSet.has(value)),
  };
}

function findAliasMatches(template: DeviceTemplate): TaxonomyAliasMatch[] {
  const inputs: Array<{ field: TaxonomyRegistryField; values: string[] }> = [
    { field: "category", values: template.category ? [template.category] : [] },
    { field: "deviceType", values: template.deviceType ? [template.deviceType] : [] },
    { field: "roleTags", values: template.roleTags ?? [] },
    { field: "deviceCapabilities", values: template.deviceCapabilities ?? [] },
    { field: "protocols", values: template.protocols ?? [] },
  ];
  const matches: TaxonomyAliasMatch[] = [];
  for (const { field, values } of inputs) {
    for (const value of values) {
      const input = normalize(value);
      for (const entry of TAXONOMY_ALIAS_ENTRIES) {
        if (entry.field !== field) continue;
        const aliasMatch = entry.aliases.some((alias) => normalize(alias) === input);
        const deprecatedMatch = entry.deprecatedValues.some((deprecated) => normalize(deprecated) === input);
        if (!aliasMatch && !deprecatedMatch) continue;
        matches.push({
          field,
          inputValue: value,
          canonicalValue: entry.canonicalValue,
          migrationRisk: entry.migrationRisk,
          deprecated: deprecatedMatch,
          notes: entry.notes,
        });
      }
    }
  }
  return matches;
}

function hasSignal(template: DeviceTemplate, signalType: string): boolean {
  return template.ports.some((port) => normalize(String(port.signalType)) === signalType);
}

function hasConnector(template: DeviceTemplate, connectorType: string): boolean {
  return template.ports.some((port) => normalize(port.connectorType) === connectorType);
}

function hasPortLabel(template: DeviceTemplate, token: string): boolean {
  return template.ports.some((port) => normalize(port.label).includes(token));
}

export function getTaxonomyVocabularies(): TaxonomyVocabularies {
  return {
    categories: [...ALL_CATEGORIES],
    deviceTypes: DEVICE_TYPES,
    roleTags: [...ROLE_TAGS],
    deviceCapabilities: [...DEVICE_CAPABILITIES],
    protocols: [...PROTOCOLS],
  };
}

export function listTaxonomyAliases(): TaxonomyAliasEntry[] {
  return TAXONOMY_ALIAS_ENTRIES.map((entry) => ({ ...entry, aliases: [...entry.aliases], deprecatedValues: [...entry.deprecatedValues] }));
}

export function inspectTemplateTaxonomy(template: DeviceTemplate): TaxonomyInspection {
  const expectedCategory = DEVICE_TYPE_TO_CATEGORY[template.deviceType];
  return {
    readOnly: true,
    template: {
      deviceType: template.deviceType,
      category: template.category,
      roleTags: valueState(template.roleTags, ROLE_TAGS),
      deviceCapabilities: valueState(template.deviceCapabilities, DEVICE_CAPABILITIES),
      protocols: valueState(template.protocols, PROTOCOLS),
      reviewStatus: template.reviewStatus,
      classificationConfidence: template.classificationConfidence,
      evidenceRefCount: template.evidenceRefs?.length ?? 0,
      lastReviewedBy: template.lastReviewedBy,
      lastReviewedAt: template.lastReviewedAt,
    },
    aliasMatches: findAliasMatches(template),
    category: {
      expected: expectedCategory,
      matchesCanonical: !template.category || !expectedCategory || template.category === expectedCategory,
    },
    deviceType: {
      known: Object.hasOwn(DEVICE_TYPE_TO_CATEGORY, template.deviceType),
    },
  };
}

export function previewTemplateTaxonomy(template: DeviceTemplate): TaxonomyPreview {
  const proposals = new Map<string, TaxonomyProposal>();
  const addProposal = (proposal: TaxonomyProposal) => {
    proposals.set(`${proposal.field}:${proposal.value}`, proposal);
  };

  const expectedCategory = DEVICE_TYPE_TO_CATEGORY[template.deviceType];
  if (expectedCategory && template.category !== expectedCategory) {
    addProposal({
      field: "category",
      value: expectedCategory,
      confidence: "high",
      reason: `Canonical category for deviceType "${template.deviceType}".`,
    });
  }

  if (template.deviceType === "audio-dsp") {
    addProposal({ field: "roleTags", value: "dsp", confidence: "high", reason: "audio-dsp maps cleanly to the DSP deployment tag." });
    addProposal({
      field: "deviceCapabilities",
      value: "audio-processing",
      confidence: "high",
      reason: "audio-dsp implies audio-processing capability.",
    });
  }

  if (template.deviceType === "amplifier" || hasSignal(template, "speaker-level")) {
    addProposal({ field: "roleTags", value: "amplifier", confidence: "high", reason: "Amplifier-first template or speaker-level outputs present." });
    addProposal({ field: "deviceCapabilities", value: "amplification", confidence: "high", reason: "Speaker-level output implies amplification." });
  }

  if (["display", "monitor", "tv", "projector", "screen"].includes(template.deviceType)) {
    addProposal({ field: "roleTags", value: "room-display", confidence: "medium", reason: "Display-family device type." });
  }

  if (template.deviceType === "wireless-presentation" || template.deviceType === "presentation-system") {
    addProposal({
      field: "roleTags",
      value: "wireless-presentation",
      confidence: "medium",
      reason: "Presentation device type suggests wireless-presentation context.",
    });
  }

  if (hasPortLabel(template, "aec")) {
    addProposal({ field: "roleTags", value: "aec", confidence: "medium", reason: "Port labels mention AEC explicitly." });
    addProposal({ field: "deviceCapabilities", value: "aec", confidence: "medium", reason: "Port labels mention AEC explicitly." });
  }

  if (hasSignal(template, "gpio")) {
    addProposal({ field: "deviceCapabilities", value: "gpio-control", confidence: "medium", reason: "GPIO signal present on at least one port." });
  }

  if (hasSignal(template, "serial")) {
    addProposal({ field: "deviceCapabilities", value: "serial-control", confidence: "medium", reason: "Serial control port present." });
  }

  if (hasPortLabel(template, "soft codec") || hasPortLabel(template, "usb bridge") || hasPortLabel(template, "usb bridging")) {
    addProposal({
      field: "deviceCapabilities",
      value: "usb-bridging",
      confidence: "low",
      reason: "Port labels explicitly suggest USB bridging or soft-codec behavior.",
    });
  }

  if (hasSignal(template, "dante")) {
    addProposal({ field: "protocols", value: "dante", confidence: "high", reason: "At least one port already declares Dante signalType." });
  }

  if (hasSignal(template, "aes67")) {
    addProposal({ field: "protocols", value: "aes67", confidence: "high", reason: "At least one port already declares AES67 signalType." });
  }

  if (hasSignal(template, "avb")) {
    addProposal({ field: "protocols", value: "avb", confidence: "high", reason: "At least one port already declares AVB signalType." });
  }

  if (hasSignal(template, "ndi")) {
    addProposal({ field: "protocols", value: "ndi", confidence: "high", reason: "At least one port already declares NDI signalType." });
  }

  if (hasSignal(template, "hdbaset")) {
    addProposal({ field: "protocols", value: "hdbaset", confidence: "high", reason: "At least one port already declares HDBaseT signalType." });
  }

  if (hasSignal(template, "st2110")) {
    addProposal({ field: "protocols", value: "st2110", confidence: "high", reason: "At least one port already declares ST 2110 signalType." });
  }

  if (hasSignal(template, "srt")) {
    addProposal({ field: "protocols", value: "srt", confidence: "high", reason: "At least one port already declares SRT signalType." });
  }

  if (hasSignal(template, "rtsp")) {
    addProposal({ field: "protocols", value: "rtsp", confidence: "high", reason: "At least one port already declares RTSP signalType." });
  }

  if (hasSignal(template, "rtmp")) {
    addProposal({ field: "protocols", value: "rtmp", confidence: "high", reason: "At least one port already declares RTMP signalType." });
  }

  if (hasSignal(template, "artnet")) {
    addProposal({ field: "protocols", value: "artnet", confidence: "high", reason: "At least one port already declares Art-Net signalType." });
  }

  if (hasSignal(template, "sacn")) {
    addProposal({ field: "protocols", value: "sacn", confidence: "high", reason: "At least one port already declares sACN signalType." });
  }

  if (hasPortLabel(template, "voip")) {
    addProposal({ field: "protocols", value: "voip", confidence: "medium", reason: "Port labels mention VoIP." });
  }

  if (hasPortLabel(template, "telephone") || (hasConnector(template, "rj11") && hasSignal(template, "analog-audio"))) {
    addProposal({
      field: "protocols",
      value: "pstn",
      confidence: "medium",
      reason: "Telephone-labelled or RJ11 analog-audio port suggests PSTN context.",
    });
  }

  return {
    readOnly: true,
    proposals: [...proposals.values()].filter((proposal) => {
      const currentValues = proposal.field === "category"
        ? [template.category ?? ""]
        : proposal.field === "roleTags"
          ? template.roleTags ?? []
          : proposal.field === "deviceCapabilities"
            ? template.deviceCapabilities ?? []
            : template.protocols ?? [];
      return !currentValues.includes(proposal.value);
    }),
    aliasMatches: findAliasMatches(template),
  };
}
