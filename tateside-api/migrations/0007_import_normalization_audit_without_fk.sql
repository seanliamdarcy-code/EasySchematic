ALTER TABLE import_normalization_rule_audit_log RENAME TO import_normalization_rule_audit_log_old;

CREATE TABLE import_normalization_rule_audit_log (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_email TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO import_normalization_rule_audit_log (
  id,
  rule_id,
  action,
  actor_email,
  details_json,
  created_at
)
SELECT
  id,
  rule_id,
  action,
  actor_email,
  details_json,
  created_at
FROM import_normalization_rule_audit_log_old;

DROP TABLE import_normalization_rule_audit_log_old;

CREATE INDEX idx_import_normalization_rule_audit_rule_id
ON import_normalization_rule_audit_log (rule_id, created_at);
