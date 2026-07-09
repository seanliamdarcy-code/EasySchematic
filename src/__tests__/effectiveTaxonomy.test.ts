import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsvImport } from "../import/parseCsv";
import { parseJsonImport } from "../import/parseJson";
import {
  activeCategories,
  activeDeviceTypes,
  buildDynamicEffectiveTaxonomy,
  buildStaticEffectiveTaxonomy,
  categoryOptionsForCurrent,
  deviceTypeLabel,
} from "../effectiveTaxonomy";
import type { TaxonomyRegistryValue } from "../tatesideApi";

const here = path.dirname(fileURLToPath(import.meta.url));

function registryValue(
  kind: TaxonomyRegistryValue["kind"],
  value: string,
  overrides: Partial<TaxonomyRegistryValue> = {},
): TaxonomyRegistryValue {
  return {
    id: `${kind}:${value}`,
    kind,
    value,
    normalizedKey: value.toLowerCase(),
    label: null,
    description: null,
    parentValue: null,
    status: "active",
    replacementValue: null,
    source: "human",
    version: 1,
    createdAt: "2026-07-09T00:00:00.000Z",
    createdBy: null,
    updatedAt: "2026-07-09T00:00:00.000Z",
    updatedBy: null,
    ...overrides,
  };
}

function importTaxonomyOptions(taxonomy: NonNullable<ReturnType<typeof buildDynamicEffectiveTaxonomy>>) {
  return {
    allowedDeviceTypes: taxonomy.deviceTypes.map((deviceType) => deviceType.value),
    deviceTypeCategories: Object.fromEntries(taxonomy.deviceTypes.map((deviceType) => [deviceType.value, deviceType.parentValue])),
  };
}

describe("effective taxonomy", () => {
  it("builds the static fallback from existing constants", () => {
    const taxonomy = buildStaticEffectiveTaxonomy();
    expect(taxonomy.source).toBe("static-fallback");
    expect(activeCategories(taxonomy).some((category) => category.value === "Audio")).toBe(true);
    expect(activeDeviceTypes(taxonomy).some((deviceType) => deviceType.value === "audio-dsp" && deviceType.parentValue === "Audio")).toBe(true);
  });

  it("uses dynamic categories and deviceTypes with labels and parent relationships", () => {
    const taxonomy = buildDynamicEffectiveTaxonomy([
      registryValue("category", "Audio"),
      registryValue("deviceType", "ceiling-mic", {
        label: "Ceiling Microphone",
        parentValue: "Audio",
      }),
      registryValue("roleTag", "source"),
      registryValue("deviceCapability", "dante"),
      registryValue("protocol", "aes67"),
    ]);

    expect(taxonomy?.source).toBe("dynamic");
    expect(activeCategories(taxonomy!).map((category) => category.value)).toEqual(["Audio"]);
    expect(activeDeviceTypes(taxonomy!)).toEqual([
      {
        value: "ceiling-mic",
        label: "Ceiling Microphone",
        parentValue: "Audio",
        status: "active",
      },
    ]);
    expect(deviceTypeLabel(taxonomy!, "ceiling-mic")).toBe("Ceiling Microphone");
  });

  it("excludes deprecated values from normal new choices but preserves current stored values", () => {
    const taxonomy = buildDynamicEffectiveTaxonomy([
      registryValue("category", "Conferencing"),
      registryValue("category", "VC", {
        status: "deprecated",
        replacementValue: "Conferencing",
      }),
      registryValue("deviceType", "codec", {
        parentValue: "Conferencing",
      }),
      registryValue("deviceType", "old-codec", {
        parentValue: "VC",
        status: "deprecated",
        replacementValue: "codec",
      }),
    ])!;

    expect(activeCategories(taxonomy).map((category) => category.value)).toEqual(["Conferencing"]);
    expect(activeDeviceTypes(taxonomy).map((deviceType) => deviceType.value)).toEqual(["codec"]);
    expect(categoryOptionsForCurrent(taxonomy, "VC")).toContainEqual({
      value: "VC",
      label: "VC",
      status: "deprecated",
    });
    expect(categoryOptionsForCurrent(taxonomy, "Accessories")).toContainEqual({
      value: "Accessories",
      label: "Accessories",
      status: "active",
    });
  });

  it("keeps dynamic device types importable and applies their parent category", () => {
    const taxonomy = buildDynamicEffectiveTaxonomy([
      registryValue("category", "Audio"),
      registryValue("deviceType", "ceiling-mic", {
        label: "Ceiling Microphone",
        parentValue: "Audio",
      }),
    ])!;
    const options = importTaxonomyOptions(taxonomy);

    const jsonResult = parseJsonImport(JSON.stringify({
      label: "Ceiling Mic 1",
      manufacturer: "Generic",
      deviceType: "ceiling-mic",
      ports: [
        {
          label: "Audio Out",
          signalType: "analog-audio",
          connectorType: "xlr-3",
          direction: "output",
        },
      ],
    }), options);

    expect(jsonResult.templates[0].template.category).toBe("Audio");
    expect(jsonResult.templates[0].validation.ok).toBe(true);

    const csvResult = parseCsvImport([
      "model_number,label,manufacturer,device_type,port_label,port_signal_type,port_connector_type,port_direction",
      ",Ceiling Mic 2,Generic,ceiling-mic,Audio Out,analog-audio,xlr-3,output",
    ].join("\n"), options);

    expect(csvResult.templates[0].template.category).toBe("Audio");
    expect(csvResult.templates[0].validation.ok).toBe(true);
  });

  it("treats empty or malformed dynamic values as unusable so callers can fall back", () => {
    expect(buildDynamicEffectiveTaxonomy([])).toBeNull();
    expect(buildDynamicEffectiveTaxonomy([
      registryValue("category", "Audio"),
      registryValue("deviceType", "ceiling-mic"),
    ])).toBeNull();
  });

  it("does not add frontend registry writes or template mutation on taxonomy load", () => {
    const apiSource = readFileSync(path.resolve(here, "../tatesideApi.ts"), "utf8");
    const taxonomySource = readFileSync(path.resolve(here, "../effectiveTaxonomy.ts"), "utf8");

    expect(apiSource).toMatch(/fetchTaxonomyRegistry/);
    expect(apiSource).toMatch(/"\/taxonomy\/registry"/);
    expect(apiSource).not.toMatch(/taxonomy\/registry\/preview/);
    expect(apiSource).not.toMatch(/taxonomy\/registry\/changes\/commit/);
    expect(taxonomySource).not.toMatch(/updateTatesideDeviceTemplate|saveTatesideDeviceTemplates|bulkEditTatesideDeviceTemplates/);
  });
});
