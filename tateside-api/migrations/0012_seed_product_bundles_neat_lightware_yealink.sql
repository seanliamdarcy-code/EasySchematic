-- Expand commercial product-bundle catalogue used by Jetbuilt import expansion
-- and project library gap analysis (known-product-bundle status).
-- Components are placeable schematic identities; the commercial SKU is not.

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
-- Neat UK commercial room-system bundles
(
  'bundle-neat-bar-2-uk',
  'neat::neatbar2bunuk',
  'Neat',
  'NEATBAR2BUNUK',
  'Neat Bar 2 + Neat Pad (UK commercial bundle)',
  '["NEATBAR2BUN","NEAT BAR 2 BUNDLE UK"]',
  'manual',
  '[{"manufacturer":"Neat","model":"Neat Bar Generation 2","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Neat","model":"NEATPAD-SE","quantityPerBundle":1,"schematicRelevant":true}]'
),
(
  'bundle-neat-bar-pro-pad',
  'neat::neatbarpropadbundle',
  'Neat',
  'NEATBARPRO-PAD-BUNDLE',
  'Neat Bar Pro + Neat Pad commercial bundle',
  '["NEATBARPRO-PAD"]',
  'manual',
  '[{"manufacturer":"Neat","model":"Neat Bar Pro","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Neat","model":"NEATPAD-SE","quantityPerBundle":1,"schematicRelevant":true}]'
),
(
  'bundle-neat-board-pro-uk',
  'neat::neatboardprobunuk',
  'Neat',
  'NEATBOARDPROBUNUK',
  'Neat Board Pro 65 commercial bundle (UK)',
  '["NEATBOARDPROBUN","NEAT BOARD PRO BUNDLE"]',
  'manual',
  '[{"manufacturer":"Neat","model":"Neat Board Pro","quantityPerBundle":1,"schematicRelevant":true}]'
),
-- Lightware TPX commercial part number → TX + RX
(
  'bundle-lightware-91350019',
  'lightware::91350019',
  'Lightware',
  '91350019',
  'Lightware TPX-2x1-TX20 + RX107 commercial bundle',
  '["TPX-2x1-TX20-RX107","TPX-2x1-TX20-RX107 bundle"]',
  'manual',
  '[{"manufacturer":"Lightware","model":"UCX-2x1-TPX-TX20","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Lightware","model":"HDMI-UCX-TPX-RX107","quantityPerBundle":1,"schematicRelevant":true}]'
),
-- Yealink MeetingBar + controller commercial SKUs
(
  'bundle-yealink-a40-031',
  'yealink::a40031',
  'Yealink',
  'A40-031',
  'Yealink MeetingBar A40 + CTP25 commercial bundle',
  '["A40-031-V2","A40 031"]',
  'manual',
  '[{"manufacturer":"Yealink","model":"MeetingBar A40","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"CTP25","quantityPerBundle":1,"schematicRelevant":true}]'
),
(
  'bundle-yealink-a50-031',
  'yealink::a50031',
  'Yealink',
  'A50-031',
  'Yealink MeetingBar A50 + CTP25 commercial bundle',
  '["A50 031"]',
  'manual',
  '[{"manufacturer":"Yealink","model":"MeetingBar A50","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"CTP25","quantityPerBundle":1,"schematicRelevant":true}]'
)
ON CONFLICT(unique_key) DO UPDATE SET
  manufacturer = excluded.manufacturer,
  sku = excluded.sku,
  label = excluded.label,
  aliases_json = excluded.aliases_json,
  source = excluded.source,
  components_json = excluded.components_json,
  updated_at = datetime('now');
