import assert from "node:assert/strict";
import test from "node:test";

import {
  getTaxonomyVocabularies,
  inspectTemplateTaxonomy,
  listTaxonomyAliases,
  previewTemplateTaxonomy,
} from "../dist-tateside-api/tateside-api/src/taxonomy.js";
import { normalizeDeviceTemplate, validateDeviceTemplate } from "../dist-tateside-api/tateside-api/src/validation.js";

test("taxonomy foundation keeps legacy templates valid and empty by default", () => {
  const template = {
    label: "Legacy DSP",
    deviceType: "audio-dsp",
    ports: [
      { id: "p1", label: "LAN", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45" },
    ],
  };

  const validation = validateDeviceTemplate(template);
  assert.equal(validation.ok, true);

  const normalized = normalizeDeviceTemplate(template);
  const inspection = inspectTemplateTaxonomy(normalized);

  assert.deepEqual(inspection.template.roleTags.values, []);
  assert.deepEqual(inspection.template.deviceCapabilities.values, []);
  assert.deepEqual(inspection.template.protocols.values, []);
  assert.equal(inspection.readOnly, true);
});

test("taxonomy foundation accepts additive V2 fields and review metadata", () => {
  const template = {
    label: "Reviewed DSP",
    manufacturer: "Bose",
    modelNumber: "EX-1280",
    deviceType: "audio-dsp",
    category: "Audio",
    roleTags: ["dsp", "install-control"],
    deviceCapabilities: ["audio-processing", "matrix-routing"],
    protocols: ["dante", "amplink"],
    reviewStatus: "needs-review",
    classificationConfidence: "medium",
    evidenceRefs: [
      {
        type: "trusted-human-note",
        title: "Reviewed against source material",
        note: "Safe additive metadata only.",
        capturedAt: "2026-07-09T10:00:00Z",
      },
    ],
    lastReviewedBy: "reviewer@example.com",
    lastReviewedAt: "2026-07-09T10:00:00Z",
    ports: [
      { id: "p1", label: "Dante Primary", signalType: "dante", direction: "bidirectional", connectorType: "rj45" },
      { id: "p2", label: "GPIO", signalType: "gpio", direction: "input", connectorType: "terminal-block" },
    ],
  };

  const validation = validateDeviceTemplate(template);
  assert.equal(validation.ok, true, validation.errors.join("; "));

  const normalized = normalizeDeviceTemplate(template);
  assert.deepEqual(normalized.roleTags, ["dsp", "install-control"]);
  assert.deepEqual(normalized.deviceCapabilities, ["audio-processing", "matrix-routing"]);
  assert.deepEqual(normalized.protocols, ["dante", "amplink"]);
  assert.equal(normalized.reviewStatus, "needs-review");
  assert.equal(normalized.classificationConfidence, "medium");
  assert.equal(normalized.evidenceRefs?.[0]?.type, "trusted-human-note");
});

test("taxonomy vocabularies and alias registries are exposed as read-only controlled lists", () => {
  const vocabularies = getTaxonomyVocabularies();
  assert.ok(vocabularies.categories.includes("Audio"));
  assert.ok(vocabularies.deviceTypes.some((entry) => entry.value === "audio-dsp" && entry.category === "Audio"));
  assert.ok(vocabularies.roleTags.includes("dsp"));
  assert.ok(vocabularies.deviceCapabilities.includes("audio-processing"));
  assert.ok(vocabularies.protocols.includes("dante"));

  const aliases = listTaxonomyAliases();
  assert.ok(aliases.some((entry) => entry.field === "connectorType" && entry.canonicalValue === "terminal-block"));
  assert.ok(aliases.some((entry) => entry.field === "direction" && entry.aliases.includes("inout")));
});

test("taxonomy inspection reports state and preview stays read-only", () => {
  const template = normalizeDeviceTemplate({
    label: "Candidate Amp",
    manufacturer: "QSC",
    modelNumber: "Amp 8",
    deviceType: "amplifier",
    category: "Audio",
    roleTags: ["av-over-ip"],
    protocols: [],
    ports: [
      { id: "p1", label: "Speaker Out", signalType: "speaker-level", direction: "output", connectorType: "terminal-block" },
      { id: "p2", label: "Telephone Line", signalType: "analog-audio", direction: "bidirectional", connectorType: "rj11" },
    ],
  });
  const before = structuredClone(template);

  const inspection = inspectTemplateTaxonomy(template);
  assert.equal(inspection.deviceType.known, true);
  assert.equal(inspection.category.expected, "Amplifiers");
  assert.equal(inspection.category.matchesCanonical, false);
  assert.ok(inspection.aliasMatches.some((match) => match.field === "roleTags" && match.canonicalValue === "avoip"));

  const preview = previewTemplateTaxonomy(template);
  assert.equal(preview.readOnly, true);
  assert.ok(preview.proposals.some((proposal) => proposal.field === "category" && proposal.value === "Amplifiers"));
  assert.ok(preview.proposals.some((proposal) => proposal.field === "roleTags" && proposal.value === "amplifier"));
  assert.ok(preview.proposals.some((proposal) => proposal.field === "deviceCapabilities" && proposal.value === "amplification"));
  assert.ok(preview.proposals.some((proposal) => proposal.field === "protocols" && proposal.value === "pstn"));
  assert.deepEqual(template, before);
});

test("taxonomy preview avoids weak usb and rj11-only inference", () => {
  const template = normalizeDeviceTemplate({
    label: "Control Widget",
    deviceType: "controller",
    ports: [
      { id: "p1", label: "Service USB", signalType: "usb", direction: "bidirectional", connectorType: "usb-c" },
      { id: "p2", label: "Control", signalType: "ethernet", direction: "bidirectional", connectorType: "rj11" },
    ],
  });

  const preview = previewTemplateTaxonomy(template);
  assert.ok(!preview.proposals.some((proposal) => proposal.field === "deviceCapabilities" && proposal.value === "usb-bridging"));
  assert.ok(!preview.proposals.some((proposal) => proposal.field === "protocols" && proposal.value === "pstn"));
});
