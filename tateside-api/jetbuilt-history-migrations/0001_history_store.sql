CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  mode TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  request_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  high_water_mark TEXT
);

CREATE TABLE raw_snapshots (
  id INTEGER PRIMARY KEY,
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  resource_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parent_type TEXT,
  parent_id TEXT,
  source_updated_at TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(resource_type, source_id, payload_sha256)
);

CREATE TABLE clients (
  jetbuilt_id TEXT PRIMARY KEY,
  company_name_raw TEXT,
  source_updated_at TEXT,
  last_seen_run_id INTEGER NOT NULL REFERENCES sync_runs(id)
);

CREATE TABLE projects (
  jetbuilt_id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(jetbuilt_id),
  custom_id_raw TEXT,
  name_raw TEXT,
  stage_raw TEXT,
  active INTEGER,
  version_raw TEXT,
  original_version_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_seen_run_id INTEGER NOT NULL REFERENCES sync_runs(id)
);

CREATE TABLE rooms (
  jetbuilt_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(jetbuilt_id),
  name_raw TEXT,
  quantity_raw TEXT,
  active INTEGER,
  created_at TEXT,
  updated_at TEXT,
  last_seen_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  PRIMARY KEY(project_id, jetbuilt_id)
);

CREATE TABLE systems (
  jetbuilt_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(jetbuilt_id),
  name_raw TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_seen_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  PRIMARY KEY(project_id, jetbuilt_id)
);

CREATE TABLE line_items (
  jetbuilt_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(jetbuilt_id),
  room_id TEXT,
  system_id TEXT,
  product_id TEXT,
  manufacturer_raw TEXT,
  model_raw TEXT,
  part_number_raw TEXT,
  description_raw TEXT,
  quantity_raw TEXT,
  quantity_numeric REAL,
  quantity_state TEXT NOT NULL CHECK (quantity_state IN ('valid', 'zero', 'negative', 'malformed', 'missing')),
  kind_raw TEXT,
  hidden INTEGER,
  option_id TEXT,
  replacement_ids_json TEXT NOT NULL DEFAULT '[]',
  source_created_at TEXT,
  source_updated_at TEXT,
  last_seen_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  PRIMARY KEY(project_id, jetbuilt_id),
  FOREIGN KEY(project_id, room_id) REFERENCES rooms(project_id, jetbuilt_id),
  FOREIGN KEY(project_id, system_id) REFERENCES systems(project_id, jetbuilt_id)
);

CREATE TABLE line_item_presence (
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  project_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY(sync_run_id, project_id, line_item_id)
);

CREATE TABLE canonical_template_links (
  project_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  canonical_template_id TEXT NOT NULL,
  match_method TEXT NOT NULL,
  confidence TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  matcher_version TEXT NOT NULL,
  PRIMARY KEY(project_id, line_item_id),
  FOREIGN KEY(project_id, line_item_id) REFERENCES line_items(project_id, jetbuilt_id)
);

CREATE TABLE project_checkpoints (
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  project_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(sync_run_id, project_id)
);

CREATE INDEX raw_snapshots_source_idx ON raw_snapshots(resource_type, source_id, fetched_at);
CREATE INDEX projects_client_idx ON projects(client_id);
CREATE INDEX projects_created_idx ON projects(created_at);
CREATE INDEX projects_updated_idx ON projects(updated_at);
CREATE INDEX rooms_project_idx ON rooms(project_id);
CREATE INDEX systems_project_idx ON systems(project_id);
CREATE INDEX line_items_identity_idx ON line_items(lower(manufacturer_raw), lower(model_raw));
CREATE INDEX line_items_room_idx ON line_items(project_id, room_id);
CREATE INDEX line_items_system_idx ON line_items(project_id, system_id);
