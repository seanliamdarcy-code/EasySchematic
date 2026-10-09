CREATE TABLE IF NOT EXISTS product_bundles (
  id TEXT PRIMARY KEY,
  unique_key TEXT NOT NULL UNIQUE,
  manufacturer TEXT NOT NULL,
  sku TEXT NOT NULL,
  label TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  components_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_bundles_manufacturer_sku ON product_bundles(manufacturer, sku);

INSERT INTO product_bundles (
  id,
  unique_key,
  manufacturer,
  sku,
  label,
  aliases_json,
  source,
  components_json
) VALUES (
  'bundle-yealink-a50-031',
  'yealink::a50031',
  'Yealink',
  'A50-031',
  'Yealink MeetingBar A50 + CTP25 bundle',
  '[]',
  'manual',
  '[{"manufacturer":"Yealink","model":"A50","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"CTP25","quantityPerBundle":1,"schematicRelevant":true}]'
) ON CONFLICT(unique_key) DO UPDATE SET
  manufacturer = excluded.manufacturer,
  sku = excluded.sku,
  label = excluded.label,
  aliases_json = excluded.aliases_json,
  source = excluded.source,
  components_json = excluded.components_json,
  updated_at = datetime('now');
