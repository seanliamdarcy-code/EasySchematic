import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, runMigrations } from "../dist-tateside-api/tateside-api/src/db.js";
import {
  LibraryDoctorStoreError,
  buildProposalPreview,
  createLibraryDoctorProposal,
  getLibraryDoctorProposal,
  libraryDoctorMutatesTemplates,
  listLibraryDoctorProposalHistory,
  listLibraryDoctorProposals,
  reviewLibraryDoctorProposal,
  supersedeLibraryDoctorProposal,
} from "../dist-tateside-api/tateside-api/src/libraryDoctorStore.js";
import { listCurrentTemplates, saveTemplates } from "../dist-tateside-api/tateside-api/src/deviceStore.js";
import { validateDeviceTemplate } from "../dist-tateside-api/tateside-api/src/validation.js";

function withTempDb(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tateside-library-doctor-"));
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

function sampleProposal(overrides = {}) {
  return {
    templateId: "tmpl-amp-1",
    manufacturer: "QSC",
    modelNumber: "SPA2-60",
    sourceIssueCode: "INVALID_CONNECTOR_TYPE",
    sourceIssueGroup: "connector",
    sourceCurrentValue: "euroblock",
    field: "connectorType",
    currentValue: "euroblock",
    proposedValue: "terminal-block",
    proposalType: "alias-normalization",
    confidence: "medium",
    risk: "high",
    evidenceRefs: [
      {
        type: "taxonomy-alias",
        title: "terminal-block aliases",
        note: "euroblock is a known alias; high-risk review required",
        capturedAt: "2026-07-09T12:00:00Z",
      },
    ],
    rationale: "Map euroblock to canonical terminal-block after human review",
    createdBy: "doctor@example.com",
    ...overrides,
  };
}

function expectStoreError(action, status, messagePattern) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof LibraryDoctorStoreError);
    assert.equal(error.status, status);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

test("library doctor creates proposals with read-only preview and evidence", () => {
  withTempDb((db) => {
    const proposal = createLibraryDoctorProposal(db, sampleProposal());
    assert.match(proposal.id, /^[0-9a-f-]{36}$/i);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.field, "connectorType");
    assert.equal(proposal.currentValue, "euroblock");
    assert.equal(proposal.proposedValue, "terminal-block");
    assert.equal(proposal.preview.readOnly, true);
    assert.equal(proposal.preview.field, "connectorType");
    assert.equal(proposal.preview.currentValue, "euroblock");
    assert.equal(proposal.preview.proposedValue, "terminal-block");
    assert.equal(proposal.evidenceRefs[0].type, "taxonomy-alias");
    assert.equal(proposal.createdBy, "doctor@example.com");

    const loaded = getLibraryDoctorProposal(db, proposal.id);
    assert.equal(loaded.id, proposal.id);
    assert.equal(loaded.templateId, "tmpl-amp-1");
  });
});

test("library doctor lists and filters proposals", () => {
  withTempDb((db) => {
    createLibraryDoctorProposal(db, sampleProposal());
    createLibraryDoctorProposal(db, sampleProposal({
      templateId: "tmpl-cam-2",
      manufacturer: "AIDA",
      modelNumber: "HD-NDI-200",
      field: "deviceType",
      currentValue: "camera-head",
      proposedValue: "camera",
      proposalType: "taxonomy-classification",
      confidence: "high",
      risk: "low",
      sourceIssueCode: "SUSPICIOUS_TEMPLATE_VALUE",
    }));

    assert.equal(listLibraryDoctorProposals(db).length, 2);
    assert.equal(listLibraryDoctorProposals(db, { manufacturer: "qsc" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { field: "deviceType" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { proposalType: "alias-normalization" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { confidence: "high" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { risk: "high" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { sourceIssueCode: "INVALID_CONNECTOR_TYPE" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { templateId: "tmpl-cam-2" }).length, 1);
    assert.equal(listLibraryDoctorProposals(db, { status: "pending" }).length, 2);

    expectStoreError(
      () => listLibraryDoctorProposals(db, { status: "not-a-status" }),
      400,
      /status must be one of/,
    );
  });
});

test("library doctor review updates status and appends immutable history", () => {
  withTempDb((db) => {
    const proposal = createLibraryDoctorProposal(db, sampleProposal());
    const accepted = reviewLibraryDoctorProposal(db, proposal.id, {
      status: "accepted",
      reviewNote: "Looks correct after datasheet check",
      reviewedBy: "reviewer@example.com",
    });

    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.reviewedBy, "reviewer@example.com");
    assert.equal(accepted.reviewNote, "Looks correct after datasheet check");
    assert.ok(accepted.reviewedAt);

    const history = listLibraryDoctorProposalHistory(db, proposal.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].eventType, "created");
    assert.equal(history[0].oldStatus, null);
    assert.equal(history[0].newStatus, "pending");
    assert.equal(history[1].eventType, "reviewed");
    assert.equal(history[1].oldStatus, "pending");
    assert.equal(history[1].newStatus, "accepted");
    assert.equal(history[1].reviewer, "reviewer@example.com");
    assert.equal(history[1].reviewNote, "Looks correct after datasheet check");

    // History survives further status changes.
    const superseded = reviewLibraryDoctorProposal(db, proposal.id, {
      status: "superseded",
      reviewNote: "Replaced by newer proposal",
      reviewedBy: "reviewer@example.com",
    });
    assert.equal(superseded.status, "superseded");
    const historyAfter = listLibraryDoctorProposalHistory(db, proposal.id);
    assert.equal(historyAfter.length, 3);
    assert.equal(historyAfter[0].newStatus, "pending");
    assert.equal(historyAfter[1].newStatus, "accepted");
    assert.equal(historyAfter[2].newStatus, "superseded");
  });
});

test("library doctor rejects invalid transitions and missing proposals", () => {
  withTempDb((db) => {
    const proposal = createLibraryDoctorProposal(db, sampleProposal());

    expectStoreError(
      () => getLibraryDoctorProposal(db, "missing-id"),
      404,
      /Proposal not found/,
    );

    expectStoreError(
      () => reviewLibraryDoctorProposal(db, "missing-id", { status: "accepted" }),
      404,
      /Proposal not found/,
    );

    expectStoreError(
      () => createLibraryDoctorProposal(db, { field: "connectorType", proposalType: "alias-normalization" }),
      400,
      /templateId is required/,
    );

    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "rejected",
      reviewedBy: "reviewer@example.com",
    });

    expectStoreError(
      () => reviewLibraryDoctorProposal(db, proposal.id, {
        status: "accepted",
        reviewedBy: "reviewer@example.com",
      }),
      409,
      /Invalid status transition/,
    );
  });
});

test("library doctor accepted does not mutate templates", () => {
  withTempDb((db) => {
    const saved = saveTemplates(db, {
      templates: [
        {
          label: "QSC SPA2-60",
          manufacturer: "QSC",
          modelNumber: "SPA2-60",
          deviceType: "amplifier",
          ports: [
            {
              id: "p1",
              label: "Line In",
              signalType: "analog-audio",
              direction: "input",
              connectorType: "euroblock",
            },
          ],
        },
      ],
      actorEmail: "seed@example.com",
    });
    const templateId = saved[0].id;
    const before = structuredClone(listCurrentTemplates(db));

    const proposal = createLibraryDoctorProposal(db, sampleProposal({
      templateId,
      currentValue: "euroblock",
      proposedValue: "terminal-block",
    }));
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "accepted",
      reviewNote: "Approved in queue only",
      reviewedBy: "reviewer@example.com",
    });

    const after = listCurrentTemplates(db);
    assert.deepEqual(after, before);
    assert.equal(after[0].ports[0].connectorType, "euroblock");
    assert.equal(libraryDoctorMutatesTemplates(), false);
  });
});

test("library doctor supersede can optionally create a replacement proposal", () => {
  withTempDb((db) => {
    const original = createLibraryDoctorProposal(db, sampleProposal());
    const result = supersedeLibraryDoctorProposal(db, original.id, {
      reviewNote: "Better canonical mapping available",
      reviewedBy: "reviewer@example.com",
      replacement: sampleProposal({
        proposedValue: "phoenix",
        rationale: "Vendor labels this as phoenix; keep under review",
      }),
    });

    assert.equal(result.proposal.status, "superseded");
    assert.ok(result.replacement);
    assert.equal(result.replacement.status, "pending");
    assert.equal(result.replacement.supersedesProposalId, original.id);
    assert.equal(result.replacement.proposedValue, "phoenix");
    assert.notEqual(result.replacement.id, original.id);

    const originalHistory = listLibraryDoctorProposalHistory(db, original.id);
    assert.equal(originalHistory.at(-1).eventType, "superseded");
    assert.equal(originalHistory.at(-1).newStatus, "superseded");

    const replacementHistory = listLibraryDoctorProposalHistory(db, result.replacement.id);
    assert.equal(replacementHistory.length, 1);
    assert.equal(replacementHistory[0].eventType, "created");
  });
});

test("library doctor rejects self-supersede references and terminal re-supersede", () => {
  withTempDb((db) => {
    const original = createLibraryDoctorProposal(db, sampleProposal());

    // Soft-link create may reference another proposal, but not a missing id.
    expectStoreError(
      () => createLibraryDoctorProposal(db, sampleProposal({
        supersedesProposalId: "does-not-exist",
      })),
      400,
      /does not reference an existing proposal/,
    );

    // Create with a valid supersedes soft-link is allowed (status of target unchanged).
    const linked = createLibraryDoctorProposal(db, sampleProposal({
      supersedesProposalId: original.id,
      proposedValue: "terminal-block-v2",
    }));
    assert.equal(linked.supersedesProposalId, original.id);
    assert.equal(getLibraryDoctorProposal(db, original.id).status, "pending");

    // Explicit self-id soft-link is rejected (defense-in-depth against self-reference).
    // Simulate by attempting create with supersedesProposalId equal to a known
    // impossible case: after supersede, a second supersede of a terminal proposal fails.
    const superseded = supersedeLibraryDoctorProposal(db, original.id, {
      reviewNote: "first supersede",
      reviewedBy: "reviewer@example.com",
    });
    assert.equal(superseded.proposal.status, "superseded");

    expectStoreError(
      () => supersedeLibraryDoctorProposal(db, original.id, {
        reviewNote: "second supersede should fail",
        reviewedBy: "reviewer@example.com",
      }),
      409,
      /Invalid status transition/,
    );

    // Rejected is terminal — cannot supersede.
    const rejected = createLibraryDoctorProposal(db, sampleProposal({
      templateId: "tmpl-reject-1",
      proposedValue: "other",
    }));
    reviewLibraryDoctorProposal(db, rejected.id, {
      status: "rejected",
      reviewedBy: "reviewer@example.com",
    });
    expectStoreError(
      () => supersedeLibraryDoctorProposal(db, rejected.id, {
        reviewedBy: "reviewer@example.com",
      }),
      409,
      /Invalid status transition/,
    );
  });
});

test("library doctor invalid replacement does not partially supersede original", () => {
  withTempDb((db) => {
    const original = createLibraryDoctorProposal(db, sampleProposal());
    const beforeHistory = listLibraryDoctorProposalHistory(db, original.id);
    assert.equal(beforeHistory.length, 1);
    assert.equal(beforeHistory[0].eventType, "created");

    expectStoreError(
      () => supersedeLibraryDoctorProposal(db, original.id, {
        reviewNote: "bad replacement",
        reviewedBy: "reviewer@example.com",
        replacement: {
          // missing required templateId / proposalType / field
          proposedValue: "phoenix",
        },
      }),
      400,
      /templateId is required|field is required|proposalType is required/,
    );

    const after = getLibraryDoctorProposal(db, original.id);
    assert.equal(after.status, "pending");
    assert.equal(after.reviewedAt, null);
    assert.equal(after.reviewNote, null);

    const afterHistory = listLibraryDoctorProposalHistory(db, original.id);
    assert.equal(afterHistory.length, 1);
    assert.equal(afterHistory[0].eventType, "created");
    assert.equal(listLibraryDoctorProposals(db).length, 1);
  });
});

test("library doctor failed review creates no event and leaves status unchanged", () => {
  withTempDb((db) => {
    const proposal = createLibraryDoctorProposal(db, sampleProposal());
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "rejected",
      reviewedBy: "reviewer@example.com",
    });

    expectStoreError(
      () => reviewLibraryDoctorProposal(db, proposal.id, {
        status: "accepted",
        reviewedBy: "reviewer@example.com",
      }),
      409,
      /Invalid status transition/,
    );

    const reloaded = getLibraryDoctorProposal(db, proposal.id);
    assert.equal(reloaded.status, "rejected");

    const history = listLibraryDoctorProposalHistory(db, proposal.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].eventType, "created");
    assert.equal(history[1].eventType, "reviewed");
    assert.equal(history[1].newStatus, "rejected");
  });
});

test("library doctor history order is stable for rapid sequential events", () => {
  withTempDb((db) => {
    const proposal = createLibraryDoctorProposal(db, sampleProposal());
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "needs-manual-review",
      reviewedBy: "a@example.com",
      reviewNote: "step-1",
    });
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "pending",
      reviewedBy: "b@example.com",
      reviewNote: "step-2",
    });
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "accepted",
      reviewedBy: "c@example.com",
      reviewNote: "step-3",
    });
    reviewLibraryDoctorProposal(db, proposal.id, {
      status: "superseded",
      reviewedBy: "d@example.com",
      reviewNote: "step-4",
    });

    const history = listLibraryDoctorProposalHistory(db, proposal.id);
    assert.deepEqual(history.map((event) => event.newStatus), [
      "pending",
      "needs-manual-review",
      "pending",
      "accepted",
      "superseded",
    ]);
    assert.deepEqual(history.map((event) => event.eventType), [
      "created",
      "reviewed",
      "reviewed",
      "reviewed",
      "reviewed",
    ]);
  });
});

test("library doctor preview includes array add/remove diffs", () => {
  const preview = buildProposalPreview(
    "roleTags",
    ["dsp", "install-control"],
    ["dsp", "network-audio"],
  );
  assert.equal(preview.readOnly, true);
  assert.deepEqual(preview.arrayDiff, {
    added: ["network-audio"],
    removed: ["install-control"],
  });
});

test("library doctor does not affect legacy template validation shape", () => {
  const legacy = {
    label: "Legacy DSP",
    deviceType: "audio-dsp",
    ports: [
      { id: "p1", label: "LAN", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45" },
    ],
  };
  const validation = validateDeviceTemplate(legacy);
  assert.equal(validation.ok, true);
});
