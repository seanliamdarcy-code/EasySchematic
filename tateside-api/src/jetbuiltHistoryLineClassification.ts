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
  | "commercial"
  | "bulk-material"
  | "software-license"
  | "logistics"
  | "travel"
  | "annotation"
  | "mounting-hardware"
  | "furniture"
  | "consumable"
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

function rule(
  lineClass: ExactRule["class"],
  ruleId: string,
  reason: string,
): ExactRule {
  return { class: lineClass, schematicRelevant: false, ruleId, reason };
}

/**
 * Exact normalized manufacturer/model identity rules only.
 * Keys use the same deterministic normalization as quoteImport.normalizedLookupKey
 * (non-alphanumeric stripped, lowercased) so "Tateside" and "Tateside -" match equivalently.
 *
 * Policy: schematic devices are active AV (signal/processing/display/audio endpoints).
 * Mounts, furniture, bulk cabling, patch leads, consumables, labour, logistics, and
 * annotations are never schematic and must not enter the library gap queue.
 * Does not use fuzzy matching, embeddings, AI, or broad substring exclusion rules.
 */
const EXACT_NON_SCHEMATIC_RULES: Readonly<Record<string, ExactRule>> = {
  // --- Tateside / internal services & materials ---
  "tateside::installation": rule(
    "labour-service",
    "exact:tateside:installation",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::commissioning": rule(
    "labour-service",
    "exact:tateside:commissioning",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::projectmanagement": rule(
    "project-management",
    "exact:tateside:project-management",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::sundries": rule(
    "sundries",
    "exact:tateside:sundries",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::generalfixingssundries": rule(
    "sundries",
    "exact:tateside:general-fixings-sundries",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::racksundries": rule(
    "sundries",
    "exact:tateside:rack-sundries",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::discount": rule(
    "commercial",
    "exact:tateside:discount",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::zhb215": rule(
    "bulk-material",
    "exact:tateside:zhb215",
    "Exact identity verified from Jetbuilt descriptions as 1.5mm two-core LSOH loudspeaker cable",
  ),
  "tateside::zhb225": rule(
    "bulk-material",
    "exact:tateside:zhb225",
    "Exact identity verified from Jetbuilt descriptions as 2.5mm two-core LSOH loudspeaker cable",
  ),
  "tateside::cat6cable": rule(
    "bulk-material",
    "exact:tateside:cat6-cable",
    "Bulk Cat6 cable sold per metre — not a placeable schematic device",
  ),
  "tateside::programming": rule(
    "labour-service",
    "exact:tateside:programming",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::engineeringresource": rule(
    "labour-service",
    "exact:tateside:engineering-resource",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::consultancy": rule(
    "labour-service",
    "exact:tateside:consultancy",
    "Professional consultancy labour line — not a schematic device",
  ),
  "tateside::professionalservices": rule(
    "labour-service",
    "exact:tateside:professional-services",
    "Professional services labour line — not a schematic device",
  ),
  "tateside::usertraining": rule(
    "labour-service",
    "exact:tateside:user-training",
    "End-user training labour line — not a schematic device",
  ),
  "tateside::shipping": rule(
    "logistics",
    "exact:tateside:shipping",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "delivery::delivery": rule(
    "logistics",
    "exact:delivery:delivery",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::travel": rule(
    "travel",
    "exact:tateside:travel",
    "Exact deterministic normalized manufacturer/model identity match",
  ),
  "tateside::hotelexpenses": rule(
    "travel",
    "exact:tateside:hotel-expenses",
    "Travel/accommodation expense line — not a schematic device",
  ),
  "tateside::note": rule(
    "annotation",
    "exact:tateside:note",
    "Quote annotation / note line — not a schematic device",
  ),
  "tateside::restock": rule(
    "commercial",
    "exact:tateside:restock",
    "Restock / commercial stock line — not a schematic device",
  ),
  "tatesideltd::customworksfabrication": rule(
    "labour-service",
    "exact:tateside-ltd:custom-works-fabrication",
    "Custom works / fabrication labour — not a schematic device",
  ),

  // --- Software licenses ---
  "qsc::sldan16p": rule(
    "software-license",
    "exact:qsc:sldan-16-p",
    "Exact Q-SYS part number for a perpetual 16x16-channel Software Dante license",
  ),

  // --- Display / camera / bar mounts & stands (never schematic) ---
  "chief::lsm1u": rule(
    "mounting-hardware",
    "exact:chief:lsm1u",
    "Chief flat-to-wall display mount — mounting hardware only",
  ),
  "chief::xsm1u": rule(
    "mounting-hardware",
    "exact:chief:xsm1u",
    "Chief flat-to-wall large-display mount — mounting hardware only",
  ),
  "chief::fcav1u": rule(
    "mounting-hardware",
    "exact:chief:fcav1u",
    "Chief Fusion wall-mount pull-out accessory — mounting hardware only",
  ),
  "futureautomation::ps80": rule(
    "mounting-hardware",
    "exact:future-automation:ps80",
    "Future Automation articulated TV wall mount — mounting hardware only",
  ),
  "futureautomation::ps80sam115": rule(
    "mounting-hardware",
    "exact:future-automation:ps80-sam115",
    "Future Automation PS80 mount accessory — mounting hardware only",
  ),
  "neat::neatbarscreenmountkit": rule(
    "mounting-hardware",
    "exact:neat:bar-screen-mount-kit",
    "Neat Bar screen mount kit — mounting hardware only",
  ),
  "neat::neatboardproadaptivestand": rule(
    "mounting-hardware",
    "exact:neat:board-pro-adaptive-stand",
    "Neat Board Pro adaptive stand — furniture/mount only",
  ),
  "neat::neatpadglassmount": rule(
    "mounting-hardware",
    "exact:neat:pad-glass-mount",
    "Neat Pad glass mount — mounting hardware only",
  ),
  "shure::a910hcm": rule(
    "mounting-hardware",
    "exact:shure:a910-hcm",
    "Shure MXA910 hard ceiling mount accessory — mounting hardware only",
  ),
  "lightware::udkitdouble": rule(
    "mounting-hardware",
    "exact:lightware:ud-kit-double",
    "Lightware under-desk double mounting kit — mounting hardware only",
  ),
  "lightware::udmountingplatef100": rule(
    "mounting-hardware",
    "exact:lightware:ud-mounting-plate-f100",
    "Lightware under-desk mounting plate — mounting hardware only",
  ),
  "lightware::udmountingplatef110": rule(
    "mounting-hardware",
    "exact:lightware:ud-mounting-plate-f110",
    "Lightware under-desk mounting plate — mounting hardware only",
  ),
  "lightware::udmountingpsuf100": rule(
    "mounting-hardware",
    "exact:lightware:ud-mounting-psu-f100",
    "Lightware under-desk PSU mount — mounting hardware only",
  ),
  "lightware::cpopup10rn": rule(
    "mounting-hardware",
    "exact:lightware:c-popup-10rn",
    "Lightware under-desk USB-C cable retractor / management tool — not an active AV endpoint",
  ),

  // --- Furniture / enclosures / power modules (never schematic) ---
  "toptec::messenger8uheightadjustablelectern": rule(
    "furniture",
    "exact:toptec:messenger-8u-lectern",
    "Toptec Messenger lectern furniture — not a schematic device",
  ),
  "toptec::rubimono": rule(
    "furniture",
    "exact:toptec:rubi-mono",
    "Toptec RUBI mono rack furniture — not a schematic device",
  ),
  "extronelectronics::70118301": rule(
    "furniture",
    "exact:extron:cable-cubby-650-ut",
    "Extron Cable Cubby 650 UT under-table enclosure — furniture only",
  ),
  "extronelectronics::70104004": rule(
    "furniture",
    "exact:extron:retractor-bracket-kit",
    "Extron retractor bracket kit for Cable Cubby enclosures — furniture accessory",
  ),
  "extronelectronics::70106535": rule(
    "furniture",
    "exact:extron:retractor-filler-module",
    "Extron retractor filler module — furniture accessory",
  ),
  "extronelectronics::70106604": rule(
    "furniture",
    "exact:extron:retractor-series2-xl-hdmi",
    "Extron Retractor Series/2 XL HDMI cable retractor — furniture cable management",
  ),
  "extronelectronics::70106655": rule(
    "furniture",
    "exact:extron:retractor-series2-usbc",
    "Extron Retractor Series/2 USB-C cable retractor — furniture cable management",
  ),
  "extronelectronics::60178202": rule(
    "furniture",
    "exact:extron:ac-usb-311-uk",
    "Extron AC+USB 311 UK power/USB furniture module — not an active AV signal device",
  ),

  // --- Patch leads, interconnect cables, bulk cabling ---
  "kramerelectronics::cusb31ca3": rule(
    "bulk-material",
    "exact:kramer:c-usb31-ca-3",
    "Kramer USB-C to USB-A interconnect cable — bulk cabling, not a schematic device",
  ),
  "lightware::cabusbct200a": rule(
    "bulk-material",
    "exact:lightware:cab-usbc-t200a",
    "Lightware USB-C interconnect cable — bulk cabling, not a schematic device",
  ),
  "lightware::cabusbct200c": rule(
    "bulk-material",
    "exact:lightware:cab-usbc-t200c",
    "Lightware USB-C proAV interconnect cable — bulk cabling, not a schematic device",
  ),
  "ultima::779392": rule(
    "bulk-material",
    "exact:ultima:779392",
    "Ultima Cat6 0.5m patch lead — bulk cabling, not a schematic device",
  ),
  "ultima::779404": rule(
    "bulk-material",
    "exact:ultima:779404",
    "Ultima Cat6 3m patch lead — bulk cabling, not a schematic device",
  ),

  // --- Consumables ---
  "sandisk::sdsqunc032ggn6ma": rule(
    "consumable",
    "exact:sandisk:sdsqunc-032g",
    "SanDisk microSD media card for players — consumable, not a schematic device",
  ),
};

export function listJetbuiltSchematicRelevanceV1Rules(): Array<{
  normalizedIdentity: string;
  class: ExactRule["class"];
  schematicRelevant: false;
  ruleId: string;
  reason: string;
}> {
  return Object.entries(EXACT_NON_SCHEMATIC_RULES)
    .map(([normalizedIdentity, exact]) => ({
      normalizedIdentity,
      class: exact.class,
      schematicRelevant: false as const,
      ruleId: exact.ruleId,
      reason: exact.reason,
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
    const exact = EXACT_NON_SCHEMATIC_RULES[key];
    if (exact) {
      return {
        classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
        class: exact.class,
        schematicRelevant: exact.schematicRelevant,
        ruleId: exact.ruleId,
        reason: exact.reason,
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
