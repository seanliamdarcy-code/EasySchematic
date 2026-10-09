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
  'bundle-yealink-a40-031',
  'yealink::a40031',
  'Yealink',
  'A40-031',
  'Yealink MeetingBar A40 + CTP25 bundle',
  '[]',
  'manual',
  '[{"manufacturer":"Yealink","model":"A40","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"CTP25","quantityPerBundle":1,"schematicRelevant":true}]'
) ON CONFLICT(unique_key) DO UPDATE SET
  manufacturer = excluded.manufacturer,
  sku = excluded.sku,
  label = excluded.label,
  aliases_json = excluded.aliases_json,
  source = excluded.source,
  components_json = excluded.components_json,
  updated_at = datetime('now');
