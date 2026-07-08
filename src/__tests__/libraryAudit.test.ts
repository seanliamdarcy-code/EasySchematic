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
    expect(report.issueGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "INVALID_CONNECTOR_TYPE",
        currentValue: "euroblock",
        issueCount: 1,
        affectedTemplateCount: 1,
        affectedPortCount: 1,
        suggestedAction: "Review connector vocabulary alias; vendor term may need mapping to canonical terminal/phoenix connector type.",
      }),
    ]));
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
    expect(report.issueGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SUSPICIOUS_PORT_VALUE",
        currentValue: "custom",
        suggestedAction: "Review whether this is a deliberate logical/pass-through port or an unmapped physical connector/signal.",
      }),
      expect.objectContaining({
        code: "SUSPICIOUS_PORT_VALUE",
        currentValue: "other",
        suggestedAction: "Review whether this is a deliberate logical/pass-through port or an unmapped physical connector/signal.",
      }),
    ]));
  });

  it("separates noisy completeness issues from the headline actionable count", () => {
    const report = auditLibraryTemplates([
      template({ id: "missing-dimensions", heightMm: undefined }),
      template({
        id: "bad-port",
        modelNumber: "KUMO-2",
        heightMm: undefined,
        ports: [
          {
            id: "p1",
            label: "Input",
            direction: "input",
            signalType: "sdi",
            connectorType: "euroblock",
          },
        ],
      } as unknown as DeviceTemplate),
    ]);

    expect(report.countsByCode.MISSING_DIMENSIONS).toBe(2);
    expect(report.countsByCode.INVALID_CONNECTOR_TYPE).toBe(1);
    expect(report.headline).toMatchObject({
      templatesScanned: 2,
      totalIssues: 3,
      actionableIssues: 1,
      completenessIssueCount: 2,
    });
    expect(report.completeness.templatesMissingDimensions).toBe(2);
  });

  it("builds per-template rollups without dropping the flat issue list", () => {
    const report = auditLibraryTemplates([
      template({
        id: "rollup",
        ports: [
          {
            id: "p1",
            label: "In",
            direction: "inout",
            signalType: "custom",
            connectorType: "other",
          },
          {
            id: "p2",
            label: "Out",
            direction: "output",
            signalType: "custom",
            connectorType: "other",
          },
        ],
      } as unknown as DeviceTemplate),
    ]);

    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.templateSummaries[0]).toMatchObject({
      templateId: "rollup",
      manufacturer: "AJA",
      modelNumber: "KUMO",
      errorCount: 1,
      infoCount: 5,
    });
    expect(report.templateSummaries[0].topIssueCodes).toEqual(expect.arrayContaining([
      { code: "SUSPICIOUS_PORT_VALUE", count: 4 },
      { code: "INVALID_PORT_DIRECTION", count: 1 },
    ]));
    expect(report.templateSummaries[0].topCurrentValues).toEqual(expect.arrayContaining([
      { value: "custom", count: 2 },
      { value: "other", count: 2 },
    ]));
    expect(report.issueGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "INVALID_PORT_DIRECTION",
        currentValue: "inout",
        suggestedAction: "Likely direction alias for bidirectional; review before adding rule.",
      }),
    ]));
  });

  it("filters issues and recomputes rollups for drilldown", () => {
    const report = auditLibraryTemplates([
      template({
        id: "bose",
        manufacturer: "Bose Professional",
        modelNumber: "EX-1280",
        ports: [
          { id: "p1", label: "In 1", direction: "input", signalType: "analog-audio", connectorType: "euroblock" },
          { id: "p2", label: "Logic", direction: "bidirectional", signalType: "custom", connectorType: "other" },
        ],
      } as unknown as DeviceTemplate),
      template({
        id: "biamp",
        manufacturer: "Biamp",
        modelNumber: "Tesira",
        ports: [
          { id: "p1", label: "In 1", direction: "input", signalType: "analog-audio", connectorType: "euroblock" },
        ],
      } as unknown as DeviceTemplate),
    ], {
      code: "INVALID_CONNECTOR_TYPE",
      manufacturer: "Bose Professional",
      currentValue: "euroblock",
    });

    expect(report.filtersApplied).toEqual({
      code: "INVALID_CONNECTOR_TYPE",
      manufacturer: "Bose Professional",
      currentValue: "euroblock",
    });
    expect(report.scope).toMatchObject({
      templatesScanned: 2,
      issueFiltersApplied: true,
      issuesAfterFilters: 1,
    });
    expect(report.headline.totalIssues).toBe(1);
    expect(report.issueGroups).toHaveLength(1);
    expect(report.issueGroups[0]).toMatchObject({
      code: "INVALID_CONNECTOR_TYPE",
      manufacturer: "Bose Professional",
      currentValue: "euroblock",
      issueCount: 1,
      sampleTemplates: [expect.objectContaining({ templateId: "bose", issueCount: 1 })],
    });
    expect(report.templateSummaries).toHaveLength(1);
    expect(report.templateSummaries[0]).toMatchObject({
      templateId: "bose",
      errorCount: 1,
    });
    expect(report.drilldown.affectedTemplates).toHaveLength(1);
    expect(report.drilldown.affectedPorts).toEqual([
      expect.objectContaining({
        templateId: "bose",
        portLabel: "In 1",
        currentValues: [{ value: "euroblock", count: 1 }],
      }),
    ]);
  });

  it("handles unknown filter values safely", () => {
    const report = auditLibraryTemplates([template()], {
      code: "NOT_A_CODE",
      severity: "bad-severity",
      currentValue: "not-present",
    });

    expect(report.scope.issueFiltersApplied).toBe(true);
    expect(report.totalIssues).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.issueGroups).toEqual([]);
    expect(report.templateSummaries).toEqual([]);
    expect(report.drilldown.affectedPorts).toEqual([]);
  });
});
