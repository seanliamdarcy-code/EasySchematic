import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openJetbuiltHistoryDatabase } from "../../dist-tateside-api/tateside-api/src/jetbuiltHistoryStore.js";
import {
  getHistoryCanonicalMatchCoverage,
  getJetbuiltHistoryDataQuality,
  getHistoricalLineClassificationSummary,
  getCommonRoomBomPatterns,
  getCommonSystemBomPatterns,
  summarizeRepeatedPatterns,
  getClientRoomPatterns,
  JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
  jetbuiltSchematicRelevanceV1RuleCount,
  JETBUILT_FINGERPRINT_MODES,
  DEFAULT_DESIGN_FINGERPRINT_MODE,
} from "../../dist-tateside-api/tateside-api/src/jetbuiltHistoryIntelligence.js";
import { JETBUILT_COHORTS, isProjectInJetbuiltCohort } from "../../dist-tateside-api/tateside-api/src/jetbuiltHistoryCohorts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = path.resolve(root, ".tateside-data/jetbuilt-history-phase2-validation.db");
const db = openJetbuiltHistoryDatabase(dbPath);

const coverage = db.prepare(`SELECT
  (SELECT count(*) FROM projects) projectCount,
  (SELECT count(*) FROM clients) clientCount,
  (SELECT count(*) FROM rooms) roomCount,
  (SELECT count(*) FROM systems) systemCount,
  (SELECT count(*) FROM line_items) lineItemCount,
  (SELECT count(DISTINCT lower(coalesce(manufacturer_raw,''))) FROM line_items) distinctManufacturers,
  (SELECT count(DISTINCT lower(coalesce(model_raw,''))) FROM line_items) distinctModels,
  (SELECT count(*) FROM canonical_template_links) exactMatchedLineItems,
  (SELECT count(*) FROM line_items WHERE quantity_state != 'valid') invalidOrNonPositiveQuantities
`).get();

const stageCounts = Object.fromEntries(
  db.prepare(`SELECT coalesce(lower(stage_raw),'unknown') stage, count(*) c FROM projects GROUP BY 1 ORDER BY 1`).all()
    .map((r) => [r.stage, r.c]),
);

const cohortCounts = {};
const projects = db.prepare("SELECT jetbuilt_id, stage_raw FROM projects").all();
for (const cohort of JETBUILT_COHORTS) {
  cohortCounts[cohort] = projects.filter((p) => isProjectInJetbuiltCohort(p.stage_raw, cohort)).length;
}

const match = getHistoryCanonicalMatchCoverage(db);
const quality = getJetbuiltHistoryDataQuality(db);
const classSummary = getHistoricalLineClassificationSummary(db);

const fullRoom = summarizeRepeatedPatterns(db, "room", "full-source");
const schemRoom = summarizeRepeatedPatterns(db, "room", "schematic-relevant");
const fullSys = summarizeRepeatedPatterns(db, "system", "full-source");
const schemSys = summarizeRepeatedPatterns(db, "system", "schematic-relevant");

const fullRoomPatterns = getCommonRoomBomPatterns(db, { minimumOccurrence: 2, fingerprintMode: "full-source", limit: 5 });
const schemRoomPatterns = getCommonRoomBomPatterns(db, { minimumOccurrence: 2, fingerprintMode: "schematic-relevant", limit: 5 });
const fullSysPatterns = getCommonSystemBomPatterns(db, { minimumOccurrence: 2, fingerprintMode: "full-source", limit: 5 });
const schemSysPatterns = getCommonSystemBomPatterns(db, { minimumOccurrence: 2, fingerprintMode: "schematic-relevant", limit: 5 });

const clientIds = db.prepare("SELECT jetbuilt_id FROM clients ORDER BY jetbuilt_id").all().map((r) => r.jetbuilt_id);
let clientsWithRepeated = 0;
for (const clientId of clientIds) {
  const patterns = getClientRoomPatterns(db, clientId, { minimumOccurrence: 2, fingerprintMode: "full-source" });
  if (Number(patterns.total) > 0) clientsWithRepeated += 1;
}

const topMfr = db.prepare(`SELECT manufacturer_raw manufacturer, count(*) lineItemOccurrences
  FROM line_items GROUP BY lower(coalesce(manufacturer_raw,''))
  ORDER BY lineItemOccurrences DESC, lower(coalesce(manufacturer_raw,'')) LIMIT 5`).all();

const topUnmatched = (match.topUnmatchedGroups || []).slice(0, 5).map((g) => ({
  manufacturer: g.manufacturer,
  model: g.model,
  lineItemOccurrences: g.lineItemCount,
  classification: g.classification,
  historicalClass: g.historicalLineClassification?.class ?? null,
  schematicRelevant: g.historicalLineClassification?.schematicRelevant ?? null,
}));

const unmatchedOccurrenceRate = coverage.lineItemCount === 0
  ? 0
  : (coverage.lineItemCount - coverage.exactMatchedLineItems) / coverage.lineItemCount;
const validQty = db.prepare(`SELECT
  coalesce(sum(CASE WHEN quantity_state='valid' THEN quantity_numeric ELSE 0 END),0) totalValid,
  coalesce(sum(CASE WHEN quantity_state='valid' AND EXISTS (
    SELECT 1 FROM canonical_template_links c WHERE c.project_id=line_items.project_id AND c.line_item_id=line_items.jetbuilt_id
  ) THEN quantity_numeric ELSE 0 END),0) matchedValid
FROM line_items`).get();
const unmatchedValidQtyRate = Number(validQty.totalValid) === 0
  ? 0
  : (Number(validQty.totalValid) - Number(validQty.matchedValid)) / Number(validQty.totalValid);

const mostCommonRoom = fullRoomPatterns.items[0] || null;
const mostCommonSystem = fullSysPatterns.items[0] || null;

const artifact = {
  sample: {
    projectCount: Number(coverage.projectCount),
    stageCounts,
    cohortCounts,
    jetbuiltGetRequestsHistoricalSample: 256,
    jetbuiltGetRequestsThisImplementationPass: 0,
    maxProjects: 50,
    maxChildItemsPerCollection: 500,
    maxPagesPerCollection: 10,
  },
  coverage: {
    rooms: Number(coverage.roomCount),
    systems: Number(coverage.systemCount),
    lineItems: Number(coverage.lineItemCount),
    distinctManufacturers: Number(coverage.distinctManufacturers),
    distinctModels: Number(coverage.distinctModels),
    exactMatchedLineItems: Number(coverage.exactMatchedLineItems),
    unmatchedLineItems: Number(coverage.lineItemCount) - Number(coverage.exactMatchedLineItems),
    exactMatchRateByOccurrence: Number(match.exactMatchRateByOccurrence),
    exactMatchRateByValidQuantity: Number(match.exactMatchRateByValidQuantity),
    unmatchedOccurrenceRate,
    unmatchedValidQuantityRate: unmatchedValidQtyRate,
    invalidOrNonPositiveQuantities: Number(coverage.invalidOrNonPositiveQuantities),
  },
  classification: {
    classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
    exactV1RuleCount: jetbuiltSchematicRelevanceV1RuleCount(),
    deterministicallyNonSchematicLineCount: classSummary.deterministicallyNonSchematicLineCount,
    unknownLineCount: classSummary.unknownLineCount,
    lineCountsByClass: classSummary.lineCountsByClass,
  },
  fingerprintModes: {
    supported: [...JETBUILT_FINGERPRINT_MODES],
    designIntelligenceDefault: DEFAULT_DESIGN_FINGERPRINT_MODE,
  },
  duplicateChildIds: {
    rooms: {
      distinctIds: Number(coverage.roomCount),
      duplicateIdsAcrossProjects: Number(quality.duplicateChildIds.room),
      projectIdCollisions: Number(quality.duplicateChildIds.room),
    },
    systems: {
      distinctIds: Number(coverage.systemCount),
      duplicateIdsAcrossProjects: Number(quality.duplicateChildIds.system),
      projectIdCollisions: Number(quality.duplicateChildIds.system),
    },
    lineItems: {
      distinctIds: Number(coverage.lineItemCount),
      duplicateIdsAcrossProjects: Number(quality.duplicateChildIds.lineItem),
      projectIdCollisions: Number(quality.duplicateChildIds.lineItem),
    },
  },
  topManufacturersByOccurrence: topMfr.map((r) => ({
    manufacturer: r.manufacturer,
    lineItemOccurrences: r.lineItemOccurrences,
  })),
  topUnmatchedGroups: topUnmatched,
  patterns: {
    fullSource: {
      repeatedRoomPatternCount: fullRoom.repeatedPatternCount,
      crossProjectRoomPatternCount: fullRoom.crossProjectRepeatedPatternCount,
      crossClientRoomPatternCount: fullRoom.crossClientRepeatedPatternCount,
      largestRoomPatternRoomCount: fullRoom.largestPatternUnitCount,
      largestRoomPatternProjectCount: fullRoom.largestPatternProjectCount,
      repeatedSystemPatternCount: fullSys.repeatedPatternCount,
      crossProjectSystemPatternCount: fullSys.crossProjectRepeatedPatternCount,
      crossClientSystemPatternCount: fullSys.crossClientRepeatedPatternCount,
      largestSystemPatternSystemCount: fullSys.largestPatternUnitCount,
      largestSystemPatternProjectCount: fullSys.largestPatternProjectCount,
      mostCommonRoomPattern: mostCommonRoom ? {
        roomCount: mostCommonRoom.roomCount,
        projectCount: mostCommonRoom.projectCount,
        clientCount: mostCommonRoom.clientCount,
        exactMatchCoverage: mostCommonRoom.exactMatchCoverage,
        bomEntryCount: Array.isArray(mostCommonRoom.bomEntries) ? mostCommonRoom.bomEntries.length : null,
        patternKind: mostCommonRoom.patternKind,
      } : null,
      mostCommonSystemPattern: mostCommonSystem ? {
        systemCount: mostCommonSystem.systemCount,
        projectCount: mostCommonSystem.projectCount,
        clientCount: mostCommonSystem.clientCount,
        exactMatchCoverage: mostCommonSystem.exactMatchCoverage,
        bomEntryCount: Array.isArray(mostCommonSystem.bomEntries) ? mostCommonSystem.bomEntries.length : null,
        patternKind: mostCommonSystem.patternKind,
      } : null,
    },
    schematicRelevant: {
      classificationVersion: JETBUILT_SCHEMATIC_RELEVANCE_VERSION,
      repeatedRoomPatternCount: schemRoom.repeatedPatternCount,
      crossProjectRoomPatternCount: schemRoom.crossProjectRepeatedPatternCount,
      crossClientRoomPatternCount: schemRoom.crossClientRepeatedPatternCount,
      largestRoomPatternRoomCount: schemRoom.largestPatternUnitCount,
      largestRoomPatternProjectCount: schemRoom.largestPatternProjectCount,
      repeatedSystemPatternCount: schemSys.repeatedPatternCount,
      crossProjectSystemPatternCount: schemSys.crossProjectRepeatedPatternCount,
      crossClientSystemPatternCount: schemSys.crossClientRepeatedPatternCount,
      largestSystemPatternSystemCount: schemSys.largestPatternUnitCount,
      largestSystemPatternProjectCount: schemSys.largestPatternProjectCount,
      roomsEmptyAfterSchematicFiltering: schemRoom.emptyAfterSchematicFiltering,
      systemsEmptyAfterSchematicFiltering: schemSys.emptyAfterSchematicFiltering,
      roomPatternsSuppressedBecauseOnlyDeterministicallyNonSchematic: schemRoom.patternsSuppressedBecauseOnlyDeterministicallyNonSchematic,
      systemPatternsSuppressedBecauseOnlyDeterministicallyNonSchematic: schemSys.patternsSuppressedBecauseOnlyDeterministicallyNonSchematic,
      mostCommonRoomPattern: schemRoomPatterns.items[0] ? {
        roomCount: schemRoomPatterns.items[0].roomCount,
        projectCount: schemRoomPatterns.items[0].projectCount,
        clientCount: schemRoomPatterns.items[0].clientCount,
        exactMatchCoverage: schemRoomPatterns.items[0].exactMatchCoverage,
        bomEntryCount: Array.isArray(schemRoomPatterns.items[0].bomEntries) ? schemRoomPatterns.items[0].bomEntries.length : null,
        patternKind: schemRoomPatterns.items[0].patternKind,
      } : null,
      mostCommonSystemPattern: schemSysPatterns.items[0] ? {
        systemCount: schemSysPatterns.items[0].systemCount,
        projectCount: schemSysPatterns.items[0].projectCount,
        clientCount: schemSysPatterns.items[0].clientCount,
        exactMatchCoverage: schemSysPatterns.items[0].exactMatchCoverage,
        bomEntryCount: Array.isArray(schemSysPatterns.items[0].bomEntries) ? schemSysPatterns.items[0].bomEntries.length : null,
        patternKind: schemSysPatterns.items[0].patternKind,
      } : null,
    },
    repeatedRoomPatternCount: fullRoom.repeatedPatternCount,
    repeatedSystemPatternCount: fullSys.repeatedPatternCount,
    clientsWithRepeatedRoomPatterns: clientsWithRepeated,
  },
  similaritySemantics: {
    fullSourceComponent: "full BOM-line weighted Jaccard over every retained historical line identity",
    schematicRelevantComponent: "schematic-relevant BOM-line weighted Jaccard; excludes only schematicRelevant===false under jetbuilt-schematic-relevance-v1; unknown remains included",
    compositionComponent: "system/room related-ID Jaccard (not device-only)",
    designRankingDefault: "schematicRelevantSimilarityScore primary; fullSourceSimilarityScore secondary",
    formulaFullSource: "0.90 × full BOM-line weighted Jaccard + 0.08 × system/room composition Jaccard + 0.015 same client + 0.005 same raw stage",
    formulaSchematicRelevant: "0.90 × schematic-relevant BOM-line weighted Jaccard + 0.08 × system/room composition Jaccard + 0.015 same client + 0.005 same raw stage",
  },
  dataQuality: {
    projectsWithZeroRooms: quality.projectsWithZeroRooms,
    projectsWithZeroSystems: quality.projectsWithZeroSystems,
    lineItemsMissingRoomId: quality.lineItemsMissingRoomId,
    lineItemsMissingSystemId: quality.lineItemsMissingSystemId,
    unresolvedRoomReferences: quality.unresolvedRoomReferences,
    unresolvedSystemReferences: quality.unresolvedSystemReferences,
    malformedQuantities: quality.malformedQuantities,
    zeroQuantities: quality.zeroQuantities,
    negativeQuantities: quality.negativeQuantities,
    missingManufacturer: quality.missingManufacturer,
    missingModel: quality.missingModel,
  },
  mcpDecision: "deferred",
  recommendedNextPhase: [
    "Expose bounded unmatched-device discovery queries over historical usage.",
    "Integrate high-value unmatched real device candidates into Library Doctor MCP for reviewable proposals.",
    "Human review before any canonical library application. No fuzzy authoritative matching.",
  ],
};

const outPath = path.resolve(root, "artifacts/jetbuilt-history-intelligence-phase2.json");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  outPath,
  fullRoom,
  schemRoom,
  fullSys,
  schemSys,
  classSummary,
  unmatchedOccurrenceRate,
  unmatchedValidQtyRate,
  clientsWithRepeated,
}, null, 2));
db.close();
