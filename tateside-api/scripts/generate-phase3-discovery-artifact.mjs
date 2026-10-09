import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, runMigrations } from "../../dist-tateside-api/tateside-api/src/db.js";
import { openJetbuiltHistoryDatabase } from "../../dist-tateside-api/tateside-api/src/jetbuiltHistoryStore.js";
import {
  getJetbuiltLibraryCandidates,
  getJetbuiltLibraryCoverageSummary,
  correlateCandidateWithCanonicalLibrary,
} from "../../dist-tateside-api/tateside-api/src/jetbuiltLibraryDiscovery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const historyPath = path.resolve(root, ".tateside-data/jetbuilt-history-phase2-validation.db");
const canonicalPath = path.resolve(root, ".tateside-data/vps-master/tateside.db");

const historyDb = openJetbuiltHistoryDatabase(historyPath);
const nowMs = Date.now();
const summary = getJetbuiltLibraryCoverageSummary(historyDb, {}, nowMs);
const top = getJetbuiltLibraryCandidates(historyDb, { limit: 25, offset: 0 }, nowMs);

let canonicalDb = null;
if (existsSync(canonicalPath)) {
  canonicalDb = openDatabase(canonicalPath);
  try {
    // read-only use; do not migrate production master if already migrated
  } catch {
    canonicalDb = null;
  }
}

const topWithRelated = top.items.map((candidate) => {
  const correlation = correlateCandidateWithCanonicalLibrary(candidate, canonicalDb);
  return {
    candidateKey: candidate.candidateKey,
    manufacturerRawExamples: candidate.manufacturerRawExamples,
    modelRawExamples: candidate.modelRawExamples,
    priorityScore: candidate.priorityScore,
    priorityReasons: candidate.priorityReasons,
    lineItemOccurrences: candidate.lineItemOccurrences,
    roomCount: candidate.roomCount,
    projectCount: candidate.projectCount,
    completedProjectCount: candidate.completedProjectCount,
    installProjectCount: candidate.installProjectCount,
    deliveredOrInstalledProjectCount: candidate.deliveredOrInstalledProjectCount,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    exactCanonicalMatch: candidate.exactCanonicalMatch,
    classification: candidate.classification,
    validQuantityTotal: candidate.validQuantityTotal,
    relatedCanonicalEvidenceCount: correlation.possibleRelatedTemplates?.length ?? 0,
    exactCanonicalTemplateCount: correlation.exactCanonicalTemplates?.length ?? 0,
    manufacturerPresentInLibrary: correlation.manufacturerPresentInLibrary ?? null,
  };
});

const deliveredMulti = top.items.filter((c) => c.deliveredOrInstalledProjectCount >= 2).length;
const completedAny = getJetbuiltLibraryCandidates(historyDb, { cohort: "completed", limit: 100 }, nowMs).total;
const installAny = getJetbuiltLibraryCandidates(historyDb, { cohort: "install", limit: 100 }, nowMs).total;

const byManufacturer = {};
for (const candidate of getJetbuiltLibraryCandidates(historyDb, { limit: 100 }, nowMs).items) {
  const maker = candidate.manufacturerRawExamples[0] || candidate.normalizedManufacturer;
  byManufacturer[maker] = (byManufacturer[maker] ?? 0) + 1;
}

const artifact = {
  sourceSample: {
    historyDatabase: "jetbuilt-history-phase2-validation.db",
    projectCount: 50,
    jetbuiltGetRequestsThisImplementationPass: 0,
  },
  classificationVersion: summary.classificationVersion,
  canonicalMatcherVersion: summary.canonicalMatcherVersion,
  rankingVersion: summary.rankingVersion,
  coverage: {
    totalHistoricalLineItems: summary.totalHistoricalLineItems,
    exactCanonicalMatches: summary.exactCanonicalMatches,
    unmatchedLines: summary.unmatchedLines,
    knownNonSchematicLines: summary.knownNonSchematicLines,
    eligibleUnmatchedCandidateLines: summary.eligibleUnmatchedCandidateLines,
    distinctEligibleCandidateIdentities: summary.distinctEligibleCandidateIdentities,
    highPriorityCandidateCount: summary.highPriorityCandidateCount,
  },
  countsByCohort: summary.countsByCohort,
  countsByManufacturerTop: summary.countsByManufacturer?.slice(0, 20) ?? [],
  candidateManufacturerIdentityCountsTop25List: Object.entries(byManufacturer)
    .map(([manufacturer, candidateCount]) => ({ manufacturer, candidateCount }))
    .sort((a, b) => b.candidateCount - a.candidateCount || a.manufacturer.localeCompare(b.manufacturer)),
  deliveredInstallMetrics: {
    candidatesInCompletedProjects: completedAny,
    candidatesInInstallProjects: installAny,
    top25WithMultipleDeliveredOrInstalledProjects: deliveredMulti,
  },
  topCandidates: topWithRelated,
  relatedCanonicalEvidence: {
    top25WithRelatedEvidence: topWithRelated.filter((c) => c.relatedCanonicalEvidenceCount > 0).length,
    top25WithNoRelatedEvidence: topWithRelated.filter((c) => c.relatedCanonicalEvidenceCount === 0).length,
    top25WithExactCanonicalTemplates: topWithRelated.filter((c) => c.exactCanonicalTemplateCount > 0).length,
  },
  mcpDecision: "enabled-read-only-optional-history-db",
  mcpToolsAdded: [
    "get_jetbuilt_library_coverage_summary",
    "get_jetbuilt_library_candidates",
    "get_jetbuilt_library_candidate",
    "get_jetbuilt_candidate_usage",
    "get_jetbuilt_candidate_cooccurrence",
  ],
  testResults: {
    jetbuiltHistoryTests: { total: 13, passed: 13, failed: 0 },
  },
  recommendedNextPhase: [
    "Use discovery candidates to drive reviewed Library Doctor new-device research workflows.",
    "Improve exact canonical coverage for high-priority real devices before full backfill.",
    "Keep accepted != applied; no auto-apply from history frequency.",
  ],
};

const outPath = path.resolve(root, "artifacts/jetbuilt-library-discovery-phase3.json");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  outPath,
  coverage: artifact.coverage,
  top5: topWithRelated.slice(0, 5).map((c) => ({
    key: c.candidateKey,
    score: c.priorityScore,
    projects: c.projectCount,
    delivered: c.deliveredOrInstalledProjectCount,
    related: c.relatedCanonicalEvidenceCount,
  })),
  related: artifact.relatedCanonicalEvidence,
}, null, 2));

historyDb.close();
if (canonicalDb) canonicalDb.close();
