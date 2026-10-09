CREATE TABLE IF NOT EXISTS jetbuilt_project_gap_candidate_results (
  run_key TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  project_number TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  canonical_snapshot_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposal-created', 'validation-failed')),
  attempted_payload_json TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL DEFAULT '[]',
  proposal_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_key, candidate_key)
);

CREATE INDEX IF NOT EXISTS idx_jetbuilt_project_gap_results_project
ON jetbuilt_project_gap_candidate_results (project_number, updated_at);
