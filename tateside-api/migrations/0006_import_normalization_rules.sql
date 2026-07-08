CREATE TABLE IF NOT EXISTS import_normalization_rules (
  id TEXT PRIMARY KEY,
  field_kind TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  normalized_raw_value TEXT NOT NULL,
  manufacturer TEXT,
  normalized_manufacturer TEXT,
  model_number TEXT,
  normalized_model_number TEXT,
  canonical_value TEXT,
  custom_definition_id TEXT,
  scope TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'reviewed',
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_email TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by_email TEXT,
  CHECK (field_kind IN ('connectorType', 'signalType', 'deviceType')),
  CHECK (scope IN ('model', 'manufacturer', 'global')),
  CHECK (trust_level IN ('draft', 'reviewed', 'trusted_standard')),
  CHECK (
    (canonical_value IS NOT NULL AND custom_definition_id IS NULL)
    OR
    (canonical_value IS NULL AND custom_definition_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_normalization_rules_unique
ON import_normalization_rules (
  field_kind,
  normalized_raw_value,
  scope,
  coalesce(normalized_manufacturer, ''),
  coalesce(normalized_model_number, '')
);

CREATE INDEX IF NOT EXISTS idx_import_normalization_rules_lookup
ON import_normalization_rules (
  field_kind,
  normalized_raw_value,
  normalized_manufacturer,
  normalized_model_number,
  scope
);

CREATE TABLE IF NOT EXISTS import_normalization_rule_audit_log (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_email TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (rule_id) REFERENCES import_normalization_rules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_import_normalization_rule_audit_rule_id
ON import_normalization_rule_audit_log (rule_id, created_at);
