INSERT INTO product_bundles (
  id,
  unique_key,
  manufacturer,
  sku,
  label,
  aliases_json,
  source,
  components_json
) VALUES
(
  'bundle-neat-bar-2-uk',
  'neat::neatbar2bunuk',
  'Neat',
  'NEATBAR2BUNUK',
  'Neat Bar 2 + Neat Pad bundle',
  '[]',
  'manual',
  '[{"manufacturer":"Neat","model":"Neat Bar 2","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Neat","model":"Neat Pad","quantityPerBundle":1,"schematicRelevant":true}]'
),
(
  'bundle-neat-bar-pro-pad',
  'neat::neatbarpropadbundle',
  'Neat',
  'NEATBARPRO-PAD-BUNDLE',
  'Neat Bar Pro + Neat Pad bundle',
  '[]',
  'manual',
  '[{"manufacturer":"Neat","model":"Neat Bar Pro","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Neat","model":"Neat Pad","quantityPerBundle":1,"schematicRelevant":true}]'
)
ON CONFLICT(unique_key) DO UPDATE SET
  manufacturer = excluded.manufacturer,
  sku = excluded.sku,
  label = excluded.label,
  aliases_json = excluded.aliases_json,
  source = excluded.source,
  components_json = excluded.components_json,
  updated_at = datetime('now');
