-- Yealink MVC commercial kits expand to placeable components on import/gap.
-- Jetbuilt quotes the commercial SKU only; package contents from Yealink official FAQ
-- for MVC S90 and explicit Jetbuilt description for MVC840-WPP-GEN2.

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
  'bundle-yealink-mvcs90-c5u-004',
  'yealink::mvcs90c5u004',
  'Yealink',
  'MVCS90-C5U-004',
  'Yealink MVC S90-C5U Microsoft Teams Rooms kit (extra-large / boardroom)',
  '["MVC S90-C5U-004","MVC S90-C5U","MVCS90-C5U","S90-C5U-004"]',
  'manufacturer',
  '[{"manufacturer":"Yealink","model":"MCore 4","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"MTouch Plus","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"UVC86","quantityPerBundle":2,"schematicRelevant":true},{"manufacturer":"Yealink","model":"AVHub","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"RoomSensor","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"MVC-BYOD-Extender","quantityPerBundle":1,"schematicRelevant":true}]'
),
(
  'bundle-yealink-mvc840-wpp-gen2',
  'yealink::mvc840wppgen2',
  'Yealink',
  'MVC840-WPP-GEN2',
  'Yealink MVC840 Gen2 Teams Room kit (from Jetbuilt description BOM)',
  '["MVC840 WPP GEN2"]',
  'manual',
  '[{"manufacturer":"Yealink","model":"UVC84","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"MCore 4","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"MTouch Plus","quantityPerBundle":1,"schematicRelevant":true},{"manufacturer":"Yealink","model":"VCM34","quantityPerBundle":2,"schematicRelevant":true},{"manufacturer":"Yealink","model":"WPP20","quantityPerBundle":1,"schematicRelevant":false},{"manufacturer":"Yealink","model":"MSPEAKERII","quantityPerBundle":1,"schematicRelevant":false}]'
)
ON CONFLICT(unique_key) DO UPDATE SET
  manufacturer = excluded.manufacturer,
  sku = excluded.sku,
  label = excluded.label,
  aliases_json = excluded.aliases_json,
  source = excluded.source,
  components_json = excluded.components_json,
  updated_at = datetime('now');
