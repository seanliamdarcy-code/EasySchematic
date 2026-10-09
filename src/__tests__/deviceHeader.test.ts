import { describe, expect, it } from "vitest";
import { resolveDeviceHeader } from "../displayName";
import { headerBandHeight } from "../auxiliaryData";
import type { DeviceData } from "../types";

const data: DeviceData = { label: "Video Conferencing Bar", manufacturer: "Neat", modelNumber: "Neat Bar Pro", shortName: "Bar", deviceType: "video-bar", ports: [], auxiliaryData: [{ text: "{{deviceType}}", position: "header" }, { text: "Engineering note", position: "header" }] };
const enabled = { deviceHeader: { showManufacturerModel: true } };
describe("Device header presentation", () => {
  it("keeps legacy labels/rows unchanged until enabled, then uses label and deduplicated make/model", () => {
    expect(resolveDeviceHeader(data).displayHeader).toEqual([data.label]);
    expect(resolveDeviceHeader(data).auxiliaryData).toEqual(data.auxiliaryData);
    const header = resolveDeviceHeader(data, { ...enabled, useShortNames: true, wrapDeviceLabels: true });
    expect(header.displayHeader).toEqual([data.label, "Neat Bar Pro"]);
    expect(header.label.wrap).toBe(false);
    expect(header.auxiliaryData).toEqual([{ text: "Engineering note", position: "header" }]);
    expect(headerBandHeight(header.auxiliaryData, header.labelZone) % 20).toBe(0);
    expect(data.auxiliaryData).toHaveLength(2);
  });
  it.each([
    ["Lightware", "HDMI-UCX-TPX-RX107", "Lightware HDMI-UCX-TPX-RX107"],
    ["Neat", "neat Bar Pro", "neat Bar Pro"],
    ["Samsung", "", "Samsung"], ["", "QM55C", "QM55C"], ["", "", ""],
  ])("combines %s / %s", (manufacturer, modelNumber, expected) => {
    expect(resolveDeviceHeader({ ...data, manufacturer, modelNumber }, enabled).line2).toBe(expected);
  });
  it("supports explicit overrides, empty-text reset and per-Device visibility", () => {
    expect(resolveDeviceHeader({ ...data, headerLine2: "Samsung – model TBC" }, enabled).line2).toBe("Samsung – model TBC");
    expect(resolveDeviceHeader({ ...data, headerLine2: "" }, enabled).line2).toBe("Neat Bar Pro");
    expect(resolveDeviceHeader({ ...data, showManufacturerModel: false }, enabled).line2).toBe("");
    expect(resolveDeviceHeader({ ...data, showDeviceType: true }, enabled).auxiliaryData).toEqual(data.auxiliaryData);
    expect(resolveDeviceHeader({ ...data, deviceType: "external-endpoint", showManufacturerModel: true }, enabled).line2).toBe("");
  });
});
