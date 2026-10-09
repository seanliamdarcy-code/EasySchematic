-- Library Doctor proposal/review queue foundation.
-- Proposals and review history only. No template mutation / apply path.

CREATE TABLE IF NOT EXISTS library_doctor_proposals (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  manufacturer TEXT,
  model_number TEXT,
  source_issue_code TEXT,
  source_issue_group TEXT,
  source_current_value_json TEXT,
  field TEXT NOT NULL,
  current_value_json TEXT,
  proposed_value_json TEXT,
  proposal_type TEXT NOT NULL,
  confidence TEXT NOT NULL,
  risk TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  supersedes_proposal_id TEXT,
  CHECK (status IN ('pending', 'accepted', 'rejected', 'needs-manual-review', 'superseded')),
  CHECK (confidence IN ('low', 'medium', 'high')),
  CHECK (risk IN ('low', 'medium', 'high'))
);

-- No FK to device templates: review history must survive template changes/deletes.
-- Soft reference only for supersession chains (no cascade delete).
CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_status
ON library_doctor_proposals (status, created_at);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_template
ON library_doctor_proposals (template_id, status);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_manufacturer
ON library_doctor_proposals (manufacturer, status);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_field
ON library_doctor_proposals (field, status);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_type
ON library_doctor_proposals (proposal_type, status);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_source_code
ON library_doctor_proposals (source_issue_code, status);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposals_confidence_risk
ON library_doctor_proposals (confidence, risk, status);

-- Append-only review/event history. No FK cascade so history is retained
-- even if a proposal row is later removed or status changes.
CREATE TABLE IF NOT EXISTS library_doctor_proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reviewer TEXT,
  review_note TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (event_type IN ('created', 'reviewed', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_library_doctor_proposal_events_proposal
ON library_doctor_proposal_events (proposal_id, created_at);
