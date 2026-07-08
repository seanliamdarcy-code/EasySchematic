import { describe, expect, it } from "vitest";
import { auditLibraryTemplates } from "../../tateside-api/src/libraryAudit";
import type { DeviceTemplate } from "../types";

function template(overrides: Partial<DeviceTemplate> = {}): DeviceTemplate {
  return {
    id: "tpl-1",
    label: "AJA KUMO",
    manufacturer: "AJA",
    modelNumber: "KUMO",
    deviceType: "router",
    ports: [
      {
        id: "p1",
        label: "SDI In 1",
        direction: "input",
        signalType: "sdi",
        connectorType: "bnc",
      },
    ],
    ...overrides,
  };
}

describe("auditLibraryTemplates", () => {
  it("reports missing template fields", () => {
    const report = auditLibraryTemplates([
      template({
        manufacturer: "",
        modelNumber: "",
        label: "",
        deviceType: "",
        category: "",
        ports: [],
      }),
    ]);

    expect(report.totalTemplatesScanned).toBe(1);
    expect(report.countsByCode).toMatchObject({
      MISSING_MANUFACTURER: 1,
      MISSING_MODEL: 1,
      MISSING_NAME: 1,
      MISSING_DEVICE_TYPE: 1,
      MISSING_CATEGORY: 1,
    });
    expect(report.countsBySeverity.error).toBeGreaterThan(0);
  });

  it("reports invalid connector, signal, and direction values", () => {
    const report = auditLibraryTemplates([
      template({
        ports: [
          {
            id: "p1",
            label: "Mystery",
            direction: "sideways",
            signalType: "digital-video",
            connectorType: "euroblock",
          },
        ],
      } as unknown as DeviceTemplate),
    ]);

    expect(report.countsByCode).toMatchObject({
      INVALID_PORT_DIRECTION: 1,
      INVALID_SIGNAL_TYPE: 1,
      INVALID_CONNECTOR_TYPE: 1,
    });
  });

  it("reports duplicate manufacturer and model combinations", () => {
    const report = auditLibraryTemplates([
      template({ id: "one", label: "KUMO 1" }),
      template({ id: "two", label: "KUMO 2" }),
    ]);

    expect(report.countsByCode.DUPLICATE_MANUFACTURER_MODEL).toBe(2);
    expect(report.affectedTemplates.map((entry) => entry.templateId).sort()).toContain("one");
  });

  it("reports suspicious generic template and port values", () => {
    const report = auditLibraryTemplates([
      template({
        manufacturer: "Unknown",
        deviceType: "other",
        category: "Uncategorized",
        ports: [
          {
            id: "p1",
            label: "Network",
            direction: "bidirectional",
            signalType: "custom",
            connectorType: "other",
          },
        ],
      }),
    ]);

    expect(report.countsByCode.SUSPICIOUS_TEMPLATE_VALUE).toBe(3);
    expect(report.countsByCode.SUSPICIOUS_PORT_VALUE).toBe(2);
  });
});
