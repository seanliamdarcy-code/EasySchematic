CREATE TABLE IF NOT EXISTS schematics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  current_version_sequence INTEGER NOT NULL CHECK (current_version_sequence >= 1),
  current_size_bytes INTEGER NOT NULL CHECK (current_size_bytes >= 0),
  sharepoint_site_id TEXT,
  sharepoint_drive_id TEXT,
  sharepoint_item_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_email TEXT,
  updated_by_email TEXT,
  FOREIGN KEY (current_version_id) REFERENCES schematic_versions(id)
);

CREATE TABLE IF NOT EXISTS schematic_versions (
  id TEXT PRIMARY KEY,
  schematic_id TEXT NOT NULL,
  version_sequence INTEGER NOT NULL CHECK (version_sequence >= 1),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  source TEXT CHECK (source IS NULL OR length(source) <= 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_email TEXT,
  FOREIGN KEY (schematic_id) REFERENCES schematics(id) ON DELETE CASCADE,
  UNIQUE (schematic_id, version_sequence)
);

CREATE TABLE IF NOT EXISTS schematic_audit_log (
  id TEXT PRIMARY KEY,
  schematic_id TEXT NOT NULL,
  version_id TEXT,
  action TEXT NOT NULL,
  actor_email TEXT,
  source TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (schematic_id) REFERENCES schematics(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES schematic_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_schematics_updated_at ON schematics(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_schematic_versions_schematic_id ON schematic_versions(schematic_id, version_sequence DESC);
CREATE INDEX IF NOT EXISTS idx_schematic_audit_log_schematic_id ON schematic_audit_log(schematic_id, created_at DESC);
