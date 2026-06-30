import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAiWorkflowConfig } from "../../tateside-api/src/aiProvider.ts";
import { getEscalationReason, getHighRiskDeviceTypes, getResearchPassRoute } from "../../tateside-api/src/deviceResearch.ts";
import { openDatabase, runMigrations } from "../../tateside-api/src/db.ts";
import { saveTemplates, listCurrentTemplates } from "../../tateside-api/src/deviceStore.ts";
import type { DeviceTemplate } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.OPENROUTER_QUOTE_EXTRACTION_MODEL;
  delete process.env.OPENROUTER_DEVICE_RESEARCH_MODEL;
  delete process.env.OPENROUTER_DEVICE_ESCALATION_MODEL;
  delete process.env.OPENROUTER_QUOTE_EXTRACTION_REASONING_EFFORT;
  delete process.env.OPENROUTER_DEVICE_RESEARCH_REASONING_EFFORT;
  delete process.env.OPENROUTER_DEVICE_ESCALATION_REASONING_EFFORT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("quote import research config", () => {
  it("uses the required default model routing and reasoning effort", () => {
    const config = getAiWorkflowConfig();
    expect(config.quoteExtractionModel).toBe("google/gemini-2.5-pro");
    expect(config.deviceResearchModel).toBe("anthropic/claude-sonnet-4.5:online");
    expect(config.deviceEscalationModel).toBe("google/gemini-2.5-pro:online");
    expect(config.quoteExtractionReasoningEffort).toBe("low");
    expect(config.deviceResearchReasoningEffort).toBe("low");
    expect(config.deviceEscalationReasoningEffort).toBe("low");
  });

  it("returns advisory reasons for uncertain research results", () => {
    const highRiskTemplate: Omit<DeviceTemplate, "id" | "version"> = {
      label: "Q-SYS Core 110f",
      manufacturer: "QSC",
      modelNumber: "Core 110f",
      deviceType: "audio-dsp",
      category: "Audio",
      referenceUrl: "https://www.qsys.com/",
      ports: [
        {
          id: "lan-1",
          label: "LAN",
          signalType: "ethernet",
          connectorType: "rj45",
          direction: "bidirectional",
        },
      ],
    };
    const simpleTemplate: Omit<DeviceTemplate, "id" | "version"> = {
      label: "Samsung QM55C",
      manufacturer: "Samsung",
      modelNumber: "QM55C",
      deviceType: "display",
      category: "Displays",
      referenceUrl: "https://displays.samsung.com/",
      ports: [
        {
          id: "hdmi-1",
          label: "HDMI In 1",
          signalType: "hdmi",
          connectorType: "hdmi",
          direction: "input",
        },
      ],
    };

    expect(getHighRiskDeviceTypes()).toContain("audio-dsp");
    expect(getEscalationReason(simpleTemplate, "medium", true, [], { ok: true, errors: [], warnings: [] }))
      .toBeNull();
    expect(getEscalationReason(highRiskTemplate, "high", true, [], { ok: true, errors: [], warnings: [] }))
      .toBeNull();
    expect(getEscalationReason(highRiskTemplate, "medium", true, [], { ok: true, errors: [], warnings: [] }))
      .toMatch(/High-risk device type/);
    expect(getEscalationReason(highRiskTemplate, "low", true, [], { ok: true, errors: [], warnings: [] }))
      .toBe("Confidence is low");
    expect(getEscalationReason(highRiskTemplate, "high", false, [], { ok: true, errors: [], warnings: [] }))
      .toBe("No official manufacturer source was found");
  });

  it("selects one-pass routes for routine and manual modes", () => {
    const config = getAiWorkflowConfig();

    expect(getResearchPassRoute(false, config)).toEqual({
      model: "anthropic/claude-sonnet-4.5:online",
      reasoningEffort: "low",
      purpose: "routine_generation",
    });
    expect(getResearchPassRoute(true, config)).toEqual({
      model: "google/gemini-2.5-pro:online",
      reasoningEffort: "low",
      purpose: "escalated_verification",
    });
  });

  it("preserves AI provenance when an approved draft is saved through the normal library path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quote-import-ai-save-"));
    tempDirs.push(dir);

    const db = openDatabase(path.join(dir, "tateside.db"));
    runMigrations(db);

    saveTemplates(db, {
      templates: [
        {
          label: "Sony SRG-A40",
          manufacturer: "Sony",
          modelNumber: "SRG-A40",
          deviceType: "ptz-camera",
          category: "Sources",
          referenceUrl: "https://pro.sony/",
          ports: [
            {
              id: "port-1",
              label: "HDMI",
              signalType: "hdmi",
              connectorType: "hdmi",
              direction: "output",
            },
          ],
          aiMetadata: {
            origin: "ai_quote_import",
            quoteFilename: "sample-quote.pdf",
            extractedManufacturer: "Sony",
            extractedModel: "SRG-A40",
            modelUsed: "anthropic/claude-sonnet-4.5:online",
            reasoningEffort: "medium",
            researchedAt: "2026-06-02T12:00:00.000Z",
            confidence: "high",
            officialSourceFound: true,
            sourceReferences: [
              {
                title: "Sony SRG-A40",
                url: "https://pro.sony/",
                sourceType: "manufacturer_product_page",
              },
            ],
            warnings: [],
            escalationRequired: false,
            escalationReason: null,
            approvedAt: "2026-06-02T12:05:00.000Z",
          },
        },
      ],
      source: "ai-quote-import-approval",
    });

    const saved = listCurrentTemplates(db)[0];
    expect(saved?.aiMetadata?.origin).toBe("ai_quote_import");
    expect(saved?.aiMetadata?.quoteFilename).toBe("sample-quote.pdf");
    expect(saved?.aiMetadata?.modelUsed).toBe("anthropic/claude-sonnet-4.5:online");
    expect(saved?.aiMetadata?.sourceReferences[0]?.url).toBe("https://pro.sony/");

    db.close();
  });
});
