export const JETBUILT_COHORTS = [
  "all",
  "estimate",
  "proposal",
  "contract",
  "install",
  "completed",
  "active-commercial",
  "delivered-or-installed",
  "non-delivered",
  "excluded",
] as const;

export type JetbuiltCohort = typeof JETBUILT_COHORTS[number];

const RAW_STAGES = ["estimate", "proposal", "contract", "install", "completed", "opportunity", "icebox", "lost", "trash"] as const;

const INCLUDED: Record<JetbuiltCohort, readonly string[]> = {
  all: RAW_STAGES,
  estimate: ["estimate"],
  proposal: ["proposal"],
  contract: ["contract"],
  install: ["install"],
  completed: ["completed"],
  "active-commercial": ["opportunity", "estimate", "proposal", "contract"],
  "delivered-or-installed": ["install", "completed"],
  "non-delivered": ["opportunity", "estimate", "proposal", "contract", "icebox", "lost", "trash"],
  excluded: ["trash"],
};

const MEANING: Record<JetbuiltCohort, string> = {
  all: "All retained projects, including unknown raw stages.",
  estimate: "Quoted estimate stage only; not evidence of delivery or installation.",
  proposal: "Proposal stage only; not evidence of delivery or installation.",
  contract: "Contract stage only; not evidence of completed delivery or installation.",
  install: "Install stage only; installation state is retained without claiming final completion.",
  completed: "Completed stage only; the raw stage is retained without inferring commercial or technical acceptance details.",
  "active-commercial": "Commercial pipeline or contract stages; not evidence of delivery or installation.",
  "delivered-or-installed": "Install or completed stages; useful delivery/install evidence, not a guarantee of full delivery or handover.",
  "non-delivered": "Stages not included in the install/completed cohort; this is a reporting boundary, not proof that no delivery occurred.",
  excluded: "Administrative trash stage only; icebox and lost remain visible rather than silently excluded.",
};

export function normalizeJetbuiltStage(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function isJetbuiltCohort(value: string | undefined): value is JetbuiltCohort {
  return JETBUILT_COHORTS.includes(value as JetbuiltCohort);
}

export function cohortStages(cohort: JetbuiltCohort): readonly string[] {
  return INCLUDED[cohort];
}

export function isProjectInJetbuiltCohort(stage: string | null | undefined, cohort: JetbuiltCohort): boolean {
  return cohort === "all" || INCLUDED[cohort].includes(normalizeJetbuiltStage(stage) ?? "");
}

export function getJetbuiltCohortSemantics(): Array<{
  cohort: JetbuiltCohort;
  includedRawStages: readonly string[];
  excludedRawStages: readonly string[];
  meaning: string;
}> {
  return JETBUILT_COHORTS.map((cohort) => ({
    cohort,
    includedRawStages: INCLUDED[cohort],
    excludedRawStages: RAW_STAGES.filter((stage) => !INCLUDED[cohort].includes(stage)),
    meaning: MEANING[cohort],
  }));
}

export function jetbuiltCohortSql(cohort: JetbuiltCohort | undefined, column: string): { sql: string; values: string[] } {
  if (!cohort || cohort === "all") return { sql: "1=1", values: [] };
  const stages = INCLUDED[cohort];
  return { sql: `lower(coalesce(${column}, '')) IN (${stages.map(() => "?").join(", ")})`, values: [...stages] };
}
