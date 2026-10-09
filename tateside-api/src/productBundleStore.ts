import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProductBundleComponent, ProductBundleDefinition } from "../../src/quoteImportTypes.js";

interface ProductBundleRow {
  id: string;
  manufacturer: string;
  sku: string;
  label: string;
  aliases_json: string;
  source: ProductBundleDefinition["source"];
  components_json: string;
  created_at: string;
  updated_at: string;
}

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value: unknown): string {
  return compact(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function productBundleUniqueKey(manufacturer: string, sku: string): string {
  return `${normalizeToken(manufacturer)}::${normalizeToken(sku)}`;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function asBundle(row: ProductBundleRow): ProductBundleDefinition {
  return {
    id: row.id,
    manufacturer: row.manufacturer,
    sku: row.sku,
    label: row.label,
    aliases: parseJsonArray<string>(row.aliases_json),
    source: row.source,
    components: parseJsonArray<ProductBundleComponent>(row.components_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateBundle(input: ProductBundleDefinition): ProductBundleDefinition {
  const manufacturer = compact(input.manufacturer);
  const sku = compact(input.sku);
  const label = compact(input.label);
  if (!manufacturer) throw new Error("Bundle manufacturer is required");
  if (!sku) throw new Error("Bundle SKU is required");
  if (!label) throw new Error("Bundle label is required");
  if (!["manual", "ai_reviewed", "manufacturer"].includes(input.source)) {
    throw new Error("Bundle source is invalid");
  }

  const components = input.components
    .map((component) => ({
      manufacturer: compact(component.manufacturer),
      model: compact(component.model),
      quantityPerBundle: Math.max(1, Math.round(Number(component.quantityPerBundle))),
      schematicRelevant: component.schematicRelevant === true,
    }))
    .filter((component) => component.manufacturer && component.model && component.quantityPerBundle > 0);

  if (components.length === 0) throw new Error("At least one bundle component is required");

  return {
    id: compact(input.id) || `bundle-${randomUUID()}`,
    manufacturer,
    sku,
    label,
    aliases: (input.aliases ?? []).map(compact).filter(Boolean),
    source: input.source,
    components,
  };
}

export function listProductBundles(db: DatabaseSync): ProductBundleDefinition[] {
  const rows = db.prepare(`
    SELECT id, manufacturer, sku, label, aliases_json, source, components_json, created_at, updated_at
    FROM product_bundles
    ORDER BY manufacturer, sku
  `).all() as unknown as ProductBundleRow[];
  return rows.map(asBundle);
}

export function resolveProductBundle(
  db: DatabaseSync,
  manufacturer: string | null | undefined,
  sku: string | null | undefined,
): ProductBundleDefinition | null {
  const maker = compact(manufacturer);
  const rawSku = compact(sku);
  if (!maker || !rawSku) return null;

  const key = productBundleUniqueKey(maker, rawSku);
  const direct = db.prepare(`
    SELECT id, manufacturer, sku, label, aliases_json, source, components_json, created_at, updated_at
    FROM product_bundles
    WHERE unique_key = ?
    LIMIT 1
  `).get(key) as ProductBundleRow | undefined;
  if (direct) return asBundle(direct);

  const skuKey = normalizeToken(rawSku);
  return listProductBundles(db).find((bundle) => (
    normalizeToken(bundle.manufacturer) === normalizeToken(maker)
    && (bundle.aliases ?? []).some((alias) => normalizeToken(alias) === skuKey)
  )) ?? null;
}

export function saveProductBundle(db: DatabaseSync, input: ProductBundleDefinition): ProductBundleDefinition {
  const bundle = validateBundle(input);
  db.prepare(`
    INSERT INTO product_bundles (
      id, unique_key, manufacturer, sku, label, aliases_json, source, components_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(unique_key) DO UPDATE SET
      manufacturer = excluded.manufacturer,
      sku = excluded.sku,
      label = excluded.label,
      aliases_json = excluded.aliases_json,
      source = excluded.source,
      components_json = excluded.components_json,
      updated_at = datetime('now')
  `).run(
    bundle.id,
    productBundleUniqueKey(bundle.manufacturer, bundle.sku),
    bundle.manufacturer,
    bundle.sku,
    bundle.label,
    JSON.stringify(bundle.aliases ?? []),
    bundle.source,
    JSON.stringify(bundle.components),
  );

  return resolveProductBundle(db, bundle.manufacturer, bundle.sku) ?? bundle;
}
