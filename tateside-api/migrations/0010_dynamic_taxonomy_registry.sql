CREATE TABLE taxonomy_registry_values (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'deviceType', 'roleTag', 'deviceCapability', 'protocol')),
  value TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  parent_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')) DEFAULT 'active',
  replacement_value TEXT,
  source TEXT NOT NULL CHECK (source IN ('builtin-seed', 'human', 'imported', 'system')) DEFAULT 'human',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  CHECK ((kind = 'category' AND parent_value IS NULL) OR kind <> 'category')
);

CREATE UNIQUE INDEX taxonomy_registry_values_kind_normalized_key_idx
  ON taxonomy_registry_values (kind, normalized_key);

CREATE INDEX taxonomy_registry_values_kind_status_idx
  ON taxonomy_registry_values (kind, status);

CREATE INDEX taxonomy_registry_values_kind_parent_idx
  ON taxonomy_registry_values (kind, parent_value);

CREATE TABLE taxonomy_registry_aliases (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'deviceType', 'roleTag', 'deviceCapability', 'protocol')),
  alias_value TEXT NOT NULL,
  normalized_alias_key TEXT NOT NULL,
  canonical_value TEXT NOT NULL,
  migration_risk TEXT NOT NULL CHECK (migration_risk IN ('low', 'medium', 'high')),
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE UNIQUE INDEX taxonomy_registry_aliases_kind_normalized_alias_key_idx
  ON taxonomy_registry_aliases (kind, normalized_alias_key);

CREATE INDEX taxonomy_registry_aliases_kind_canonical_idx
  ON taxonomy_registry_aliases (kind, canonical_value);

CREATE INDEX taxonomy_registry_aliases_kind_status_idx
  ON taxonomy_registry_aliases (kind, status);

CREATE TABLE taxonomy_registry_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('value', 'alias')),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'deviceType', 'roleTag', 'deviceCapability', 'protocol')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'seeded',
    'created',
    'metadata-updated',
    'deprecated',
    'reactivated',
    'alias-created',
    'alias-updated',
    'alias-deprecated'
  )),
  old_value_json TEXT,
  new_value_json TEXT,
  actor TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX taxonomy_registry_events_entity_idx
  ON taxonomy_registry_events (entity_type, entity_id, created_at);

CREATE INDEX taxonomy_registry_events_kind_idx
  ON taxonomy_registry_events (kind, created_at);
