import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import {
  buildCandidateKey,
  buildLibraryDoctorProposalCandidates,
  enqueueLibraryDoctorCandidates,
  libraryDoctorGenerationMutatesTemplates,
  previewLibraryDoctorGeneration,
} from "../dist-tateside-api/tateside-api/src/libraryDoctorProposalGenerator.js";
import {
  getLibraryDoctorProposalByGenerationKey,
  listLibraryDoctorProposals,
  reviewLibraryDoctorProposal,
} from "../dist-tateside-api/tateside-api/src/libraryDoctorStore.js";
import { listCurrentTemplates, saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";

function withTempDb(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-ld-gen-"));
  const dbPath = path.join(root, "store.db");
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    return run(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function sampleTemplates() {
  return [
    {
      label: "QSC SPA2-60",
      manufacturer: "QSC",
      modelNumber: "SPA2-60",
      deviceType: "amplifier",
      category: "Audio",
      ports: [
        {
          id: "p1",
          label: "Line In",
          signalType: "analog-audio",
          direction: "inout",
          connectorType: "euroblock",
        },
        {
          id: "p2",
          label: "Mic Combo",
          signalType: "analog-audio",
          direction: "input",
          connectorType: "xlr-trs-combo",
        },
        {
          id: "p3",
          label: "DC",
          signalType: "power",
          direction: "input",
          connectorType: "dc-barrel",
        },
      ],
    },
    {
      label: "AIDA Camera",
      manufacturer: "AIDA",
      modelNumber: "HD-100",
      deviceType: "camera-head",
      ports: [
        {
          id: "p1",
          label: "HDMI Out",
          signalType: "hdmi",
          direction: "output",
          connectorType: "hdmi",
        },
      ],
    },
  ];
}

test("candidateKey is deterministic for unchanged inputs", () => {
  const a = buildCandidateKey({
    templateId: "t1",
    field: "ports[0].direction",
    currentValue: "inout",
    proposedValue: "bidirectional",
    proposalType: "alias-normalization",
    sourceIssueCode: "TAXONOMY_ALIAS_MATCH",
  });
  const b = buildCandidateKey({
    templateId: "t1",
    field: "ports[0].direction",
    currentValue: "inout",
    proposedValue: "bidirectional",
    proposalType: "alias-normalization",
    sourceIssueCode: "TAXONOMY_ALIAS_MATCH",
  });
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);

  const changed = buildCandidateKey({
    templateId: "t1",
    field: "ports[0].direction",
    currentValue: "inout",
    proposedValue: "input",
    proposalType: "alias-normalization",
    sourceIssueCode: "TAXONOMY_ALIAS_MATCH",
  });
  assert.notEqual(a, changed);
});

test("set-like taxonomy arrays normalize order and de-dupe for candidateKey", () => {
  const roleA = buildCandidateKey({
    templateId: "t1",
    field: "roleTags",
    currentValue: ["dsp", "network-audio"],
    proposedValue: ["dsp", "network-audio", "amplifier"],
    proposalType: "taxonomy-classification",
    sourceIssueCode: "TAXONOMY_ADDITIVE_CLASSIFICATION",
  });
  const roleB = buildCandidateKey({
    templateId: "t1",
    field: "roleTags",
    currentValue: ["network-audio", "dsp"],
    proposedValue: ["amplifier", "dsp", "network-audio"],
    proposalType: "taxonomy-classification",
    sourceIssueCode: "TAXONOMY_ADDITIVE_CLASSIFICATION",
  });
  assert.equal(roleA, roleB);

  const capsA = buildCandidateKey({
    templateId: "t1",
    field: "deviceCapabilities",
    currentValue: ["aec", "audio-processing"],
    proposedValue: ["aec", "audio-processing", "amplification"],
    proposalType: "taxonomy-classification",
  });
  const capsB = buildCandidateKey({
    templateId: "t1",
    field: "deviceCapabilities",
    currentValue: ["audio-processing", "aec"],
    proposedValue: ["amplification", "audio-processing", "aec"],
    proposalType: "taxonomy-classification",
  });
  assert.equal(capsA, capsB);

  const protoA = buildCandidateKey({
    templateId: "t1",
    field: "protocols",
    currentValue: ["dante", "aes67"],
    proposedValue: ["dante", "aes67", "ndi"],
    proposalType: "taxonomy-classification",
  });
  const protoB = buildCandidateKey({
    templateId: "t1",
    field: "protocols",
    currentValue: ["aes67", "dante"],
    proposedValue: ["ndi", "dante", "aes67"],
    proposalType: "taxonomy-classification",
  });
  assert.equal(protoA, protoB);

  // Genuinely different membership must not collide.
  const different = buildCandidateKey({
    templateId: "t1",
    field: "roleTags",
    currentValue: ["dsp"],
    proposedValue: ["dsp", "aec"],
    proposalType: "taxonomy-classification",
    sourceIssueCode: "TAXONOMY_ADDITIVE_CLASSIFICATION",
  });
  assert.notEqual(roleA, different);

  // Non set-like arrays keep order sensitivity (do not globally sort).
  const orderedA = buildCandidateKey({
    templateId: "t1",
    field: "ports",
    currentValue: ["a", "b"],
    proposedValue: ["a", "b"],
    proposalType: "other",
  });
  const orderedB = buildCandidateKey({
    templateId: "t1",
    field: "ports",
    currentValue: ["b", "a"],
    proposedValue: ["a", "b"],
    proposalType: "other",
  });
  assert.notEqual(orderedA, orderedB);
});

test("preview requires scope and is read-only / conservative", () => {
  withTempDb((db) => {
    assert.throws(
      () => buildLibraryDoctorProposalCandidates(sampleTemplates(), {}),
      /scope is required/i,
    );

    const first = buildLibraryDoctorProposalCandidates(sampleTemplates(), { manufacturer: "QSC" });
    const second = buildLibraryDoctorProposalCandidates(sampleTemplates(), { manufacturer: "QSC" });
    assert.deepEqual(
      first.candidates.map((c) => c.candidateKey),
      second.candidates.map((c) => c.candidateKey),
    );

    assert.ok(first.stats.highRisk >= 1);
    assert.ok(!first.candidates.some((c) => c.currentValue === "euroblock"));
    assert.ok(!first.candidates.some((c) => c.proposedValue === "terminal-block" && String(c.field).includes("connector")));
    assert.ok(first.candidates.some((c) => c.currentValue === "inout" && c.proposedValue === "bidirectional"));
    assert.ok(first.candidates.some((c) => c.currentValue === "xlr-trs-combo" && c.proposedValue === "combo-xlr-trs"));
    assert.ok(first.candidates.some((c) => c.currentValue === "dc-barrel" && c.proposedValue === "barrel"));
    assert.ok(first.candidates.every((c) => c.readOnly === true));
    assert.ok(first.candidates.every((c) => c.risk === "low" || c.risk === "medium"));

    // No invent from missing completeness alone / product names.
    assert.ok(!first.candidates.some((c) => c.sourceIssueCode === "MISSING_DIMENSIONS"));
    assert.ok(!first.candidates.some((c) => c.sourceIssueCode === "MISSING_MANUFACTURER"));
  });
});

test("preview and enqueue are queue-only; duplicates blocked across all statuses", () => {
  withTempDb((db) => {
    const saved = saveTemplates(db, {
      templates: sampleTemplates(),
      actorEmail: "gen@example.com",
    });
    const before = structuredClone(listCurrentTemplates(db));
    const templateId = saved[0].id;

    const preview = previewLibraryDoctorGeneration(db, saved, { templateIds: [templateId] });
    assert.equal(preview.readOnly, true);
    assert.ok(preview.candidates.length > 0);
    assert.equal(listLibraryDoctorProposals(db).length, 0);

    const keys = preview.candidates.map((c) => c.candidateKey);
    const first = enqueueLibraryDoctorCandidates(db, saved, keys, "gen@example.com");
    assert.equal(first.created, keys.length);
    assert.equal(first.staleOrMissing, 0);

    // Template values unchanged after enqueue.
    assert.deepEqual(listCurrentTemplates(db).map((t) => t.ports), before.map((t) => t.ports));
    assert.equal(libraryDoctorGenerationMutatesTemplates(), false);

    const second = enqueueLibraryDoctorCandidates(db, saved, keys, "gen@example.com");
    assert.equal(second.created, 0);
    assert.equal(second.alreadyExisting, keys.length);

    // Reject one proposal — still blocks duplicate generation key.
    const proposal = listLibraryDoctorProposals(db)[0];
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "rejected",
      reviewedBy: "reviewer@example.com",
    });
    const afterReject = enqueueLibraryDoctorCandidates(db, saved, [proposal.generationKey], "gen@example.com");
    assert.equal(afterReject.created, 0);
    assert.equal(afterReject.alreadyExisting, 1);
    assert.equal(afterReject.existing[0].status, "rejected");

    // Stale key
    const stale = enqueueLibraryDoctorCandidates(db, saved, ["0".repeat(64)], "gen@example.com");
    assert.equal(stale.staleOrMissing, 1);
    assert.equal(stale.created, 0);

    // Caller cannot inject arbitrary proposed values via enqueue (only keys).
    const onlyKey = enqueueLibraryDoctorCandidates(db, saved, [keys[0]], "gen@example.com");
    assert.equal(onlyKey.created, 0);
    assert.equal(onlyKey.alreadyExisting, 1);
    const stored = getLibraryDoctorProposalByGenerationKey(db, keys[0]);
    assert.notEqual(stored.proposedValue, "HACKED");
  });
});

test("changed source state makes previous candidateKey stale", () => {
  withTempDb((db) => {
    const saved = saveTemplates(db, {
      templates: [{
        label: "Combo Device",
        manufacturer: "Acme",
        modelNumber: "C1",
        deviceType: "audio-interface",
        ports: [
          {
            id: "p1",
            label: "In",
            signalType: "analog-audio",
            direction: "inout",
            connectorType: "xlr-trs-combo",
          },
        ],
      }],
      actorEmail: "gen@example.com",
    });

    const preview = previewLibraryDoctorGeneration(db, saved, { manufacturer: "Acme" });
    const directionCandidate = preview.candidates.find((c) => c.currentValue === "inout");
    assert.ok(directionCandidate);

    // Mutate source direction outside generation (simulate library edit via save of different content).
    // We only change the in-memory snapshot for recompute, not through generation.
    const edited = structuredClone(saved);
    edited[0].ports[0].direction = "bidirectional";
    const after = enqueueLibraryDoctorCandidates(db, edited, [directionCandidate.candidateKey], "gen@example.com");
    assert.equal(after.created, 0);
    assert.equal(after.staleOrMissing, 1);
  });
});

test("camera-head medium-risk alias can generate; euroblock high-risk cannot", () => {
  const { candidates, stats } = buildLibraryDoctorProposalCandidates(sampleTemplates(), {
    fields: ["deviceType", "connectorType", "direction"],
  });
  assert.ok(candidates.some((c) => c.currentValue === "camera-head" && c.proposedValue === "camera" && c.risk === "medium"));
  assert.ok(stats.highRisk >= 1);
  assert.ok(!candidates.some((c) => c.currentValue === "euroblock"));
});

test("no product-name inference proposals", () => {
  const templates = [{
    label: "Mystery DSP Pro X",
    manufacturer: "Bose",
    modelNumber: "IP-RX-100",
    deviceType: "other",
    ports: [
      { id: "p1", label: "LAN", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45" },
    ],
  }];
  const { candidates } = buildLibraryDoctorProposalCandidates(templates, { manufacturer: "Bose" });
  assert.ok(!candidates.some((c) => c.field === "deviceType" && c.proposedValue === "audio-dsp"));
  assert.ok(!candidates.some((c) => c.field === "roleTags" && JSON.stringify(c.proposedValue).includes("dsp")));
  assert.ok(!candidates.some((c) => JSON.stringify(c.proposedValue).includes("avoip")));
});
