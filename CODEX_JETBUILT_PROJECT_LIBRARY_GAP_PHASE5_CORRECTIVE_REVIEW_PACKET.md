# Jetbuilt Project → Library Gap — Phase 5 Corrective Review Packet

## 1. Executive verdict

The narrow corrective pass is complete and locally verified. The analysis run identity now changes with relevant stable Jetbuilt project/BOM source state, proposal state is exposed as a separately versioned live overlay, cached-index misses are explicitly inconclusive, and the new-template gates now use caller-declaration names and messages that match what the backend can actually prove.

The existing Phase 5 boundaries remain intact: one project-gap MCP tool, exact lookup and identity matching, pending-only individual proposals, no apply/promote path, no data stripping, no broad backfill, and no Jetbuilt/canonical/taxonomy/schematic writes.

## 2. Exact issue found in original run identity

The original run key did not include the stored project, rooms, systems, line items, quantities, or room/system relationships. A BOM could therefore change while the project number, analysis version, and canonical snapshot stayed constant. Because persisted candidate failures are selected by `runKey`, a changed BOM could then inherit a `validation-failed` result from the older source state.

The implementation matched the concern in the corrective request; this was a real identity defect rather than a documentation-only issue.

## 3. Exact old run-identity formula

The old implementation was equivalent to:

```text
runKey = "jetbuilt-project-gap:" + SHA-256(
  normalizedProjectNumber + ":" +
  analysisVersion + ":" +
  canonicalSnapshotIdentity
)
```

The analysis version was `jetbuilt-project-library-gap-v1`.

## 4. Exact new project source fingerprint design

`projectSourceFingerprint` is SHA-256 of deterministic JSON assembled from the exact normalized rows read for the bounded analysis:

- project: Jetbuilt ID, client relationship, custom ID, name, stage, active flag, version, and original-version relationship;
- rooms ordered by Jetbuilt ID: ID, name, quantity, and active flag;
- systems ordered by Jetbuilt ID: ID and name;
- line items ordered by Jetbuilt ID: line/project IDs, room/system relationships, product ID, manufacturer, model, part number, description, raw/parsed quantity and state, kind, hidden flag, option relationship, and replacement relationships.

Source-created/source-updated timestamps, sync-run IDs, last-seen bookkeeping, and fetch timestamps are excluded. Stored canonical links are also excluded because current canonical state already has its own independent snapshot identity.

The analysis version is now `jetbuilt-project-library-gap-v2` because run-identity semantics changed.

## 5. Exact new run-identity formula

The new implementation is equivalent to:

```text
runKey = "jetbuilt-project-gap:" + SHA-256(JSON.stringify({
  projectSourceFingerprint,
  analysisVersion: "jetbuilt-project-library-gap-v2",
  canonicalSnapshotIdentity
}))
```

Identical source and canonical state produce the same key. Relevant source state or canonical state changes produce a different key without relying on unstable timestamps.

## 6. Proof changed BOM/source state changes identity

The focused Phase 5 regression proves:

- unchanged project source + unchanged canonical snapshot → identical source fingerprint and run key;
- line item added → different run key;
- that line item removed → different key from the added-line state and restoration of the original key;
- quantity changed → different source fingerprint and run key;
- line-item room and system relationships changed → different run key;
- canonical template added with project source unchanged → different canonical snapshot identity and run key.

The test uses only disposable SQLite fixtures and restores direct source mutations where needed.

## 7. Persisted failed-candidate stale-state prevention

Candidate results remain keyed and selected by exact `runKey` plus `candidateKey`. The regression persists a `validation-failed` result for `beta::camx`, confirms it produces `needs-manual-review` for the matching run, changes the source quantity, and then proves the new run returns:

```text
status = unmatched-hardware-candidate
previousResult = null
```

No migration expansion or compatibility layer was needed: the corrected run key naturally isolates prior source-state results. The complete attempted payload and exact issues remain persisted for the original run.

## 8. Proposal live-state determinism clarification

The project/canonical analysis identity deliberately excludes proposal state. The result now separately exposes:

```text
proposalStateVersion = jetbuilt-project-gap-proposal-state-v1
proposalStateIdentity = SHA-256(stable proposal and candidate-result overlay)
proposalStateSource = local | proposal-service
proposalStateSemantics = live-overlay-excluded-from-run-key
```

The overlay identity includes stable proposal identity/status/generation/alias fields and stable candidate-result content, but excludes update timestamps and request counts. A regression creates a proposal after an analysis and proves the same run key changes from an unmatched candidate to `already-proposed` while `proposalStateIdentity` changes. The entire returned payload is therefore not claimed to be immutable under one run key; project/canonical analysis identity is deterministic, while proposal status is live overlay state.

## 9. Project-not-found semantic change

Local history absence still reports that the exact project is not present in the local history database and may enter the bounded acquisition path. If the exact normalized project number/ID is absent from the configured cached index, acquisition now throws:

```text
code = project-not-found-in-cached-index
message = ...absence from Jetbuilt is not established
```

The regression proves zero Jetbuilt requests on this path. `ambiguous-project` remains unchanged for multiple exact normalized matches. No account-wide scan, broad index refresh, or backfill was added.

## 10. Quality-gate guarantee audit

The gates were retained and renamed to describe caller declarations honestly:

| Input | Backend-enforced guarantee | Not claimed |
|---|---|---|
| `identityVerifiedByCaller: true` | Caller made the required identity-review declaration | Backend independently researched the identity |
| `officialEvidenceDeclaredByCaller: true` plus an evidence type containing `official` and an HTTP(S) URL | Caller marked evidence official; URL protocol and marker shape are valid | Manufacturer owns or controls the domain |
| `physicalPortsDeclaration: complete \| not-applicable` | Declaration is present and consistent with whether ports were supplied | Backend independently discovered every physical port |
| `dimensionsDeclaration: complete \| unavailable` | Declaration is present; `complete` requires height, width, and depth | Backend independently established completeness |
| `noValidDataOmittedConfirmedByCaller: true` | Caller made the required omission/completeness confirmation | Backend independently proved no valid field was omitted |

Independent backend checks remain: required template structure, port field validation, taxonomy validation, exact canonical collisions, deterministic generation-key collision, and `classificationConfidence: high`. The regression rejects the former misleading gate names and accepts a syntactically valid `manufacturer.example` reference only as caller-declared evidence, explicitly proving that domain ownership is not inferred.

## 11. Exact files modified

Corrective-pass changes were made in:

- `tateside-api/src/jetbuiltProjectLibraryGap.ts`
- `tateside-api/src/libraryDoctorNewTemplate.ts`
- `tateside-api/src/mcpLibrary.ts`
- `tateside-api/jetbuiltHistory.local.test.mjs`
- `tateside-api/libraryDoctorNewTemplate.local.test.mjs`
- `tateside-api/mcpHttp.local.test.mjs`
- `tateside-api/schematicRoutes.local.test.mjs`
- `CODEX_JETBUILT_PROJECT_LIBRARY_GAP_PHASE5_REVIEW_PACKET.md`
- `artifacts/jetbuilt-project-library-gap-phase5.json`
- `CODEX_JETBUILT_PROJECT_LIBRARY_GAP_PHASE5_CORRECTIVE_REVIEW_PACKET.md`

The migration, HTTP/stdio registration, server identity endpoint, and other Phase 5 implementation files were inspected and retained without corrective expansion.

## 12. Tests added/changed

- Expanded the Phase 5 full-BOM test with stable rerun, add/remove line, quantity, relationship, canonical snapshot, stale persisted-failure, and proposal-overlay identity assertions.
- Expanded the bounded acquisition test with an inconclusive cached-index miss assertion and zero-request proof.
- Added a focused quality-gate guarantee test covering rejection of the misleading legacy names and acceptance of caller-marked HTTP(S) evidence without a backend domain-ownership claim.
- Updated new-template, MCP HTTP, and route fixtures to the honest caller-declaration field names.
- Updated the Epson regression to the V2 project context while preserving its complete rejected payload and no-stripping assertions.

## 13. Exact test results

- `npm run tateside:api:build`: passed.
- `npm test`: 24 files, 188 tests passed.
- `npm run jetbuilt:history:test`: 15 tests passed, including the expanded Phase 5 identity/acquisition coverage.
- Focused `mcpLibrary` + `mcpHttp` + `schematicRoutes` + `libraryDoctorNewTemplate` Node suite: 29 tests passed.
- Focused `libraryDoctorNewTemplate` suite alone: 6 tests passed.
- `npm run build`: passed; the existing Vite chunk-size advisory remained.
- Changed-file ESLint: passed with no issues.
- `git diff --check`: passed.

## 14. Security/mutation confirmation

- No deploy, production mutation, service restart, commit, push, rebase, reset, stash, or force operation occurred.
- No real Jetbuilt request or write occurred; acquisition tests used a synthetic fetch implementation.
- No real Neat, Intel, or Epson proposal was created, reviewed, accepted, rejected, superseded, or applied.
- No real canonical template, taxonomy, schematic, or proposal status was changed.
- Test proposal/candidate-result/template mutations were confined to disposable temporary SQLite databases.
- One MCP project-gap analysis tool remains; no new MCP tool or broad scan path was added.

## 15. Git diff summary

Branch and HEAD are unchanged:

```text
feature/jetbuilt-project-library-gap-phase5
042bfbd7766a9872de2f5050232cc119d8468463
```

Current tracked diff versus HEAD:

```text
9 files changed, 503 insertions(+), 18 deletions(-)
```

That tracked statistic is cumulative for the uncommitted Phase 5 branch and excludes untracked Phase 5 files, review packets, artifacts, and preserved pre-existing untracked files. `git diff --check` is clean.

## 16. Final Git status

Tracked modified files:

```text
M tateside-api/jetbuiltHistory.local.test.mjs
M tateside-api/libraryDoctorNewTemplate.local.test.mjs
M tateside-api/mcpHttp.local.test.mjs
M tateside-api/schematicRoutes.local.test.mjs
M tateside-api/src/libraryDoctorNewTemplate.ts
M tateside-api/src/mcpHttpServer.ts
M tateside-api/src/mcpLibrary.ts
M tateside-api/src/mcpServer.ts
M tateside-api/src/server.ts
```

Phase 5/corrective untracked surfaces include:

```text
?? .codex/
?? CODEX_JETBUILT_PROJECT_LIBRARY_GAP_PHASE5_REVIEW_PACKET.md
?? CODEX_JETBUILT_PROJECT_LIBRARY_GAP_PHASE5_CORRECTIVE_REVIEW_PACKET.md
?? artifacts/
?? tateside-api/migrations/0011_jetbuilt_project_gap_candidate_results.sql
?? tateside-api/src/jetbuiltProjectLibraryGap.ts
```

The repository also retains the pre-existing untracked review packets, `Device_JSONS/`, Playwright/e2e files, and `test-results/` shown by `git status --short`; none were deleted or overwritten by this corrective pass.

No commit exists for this work, and nothing was pushed or deployed.

READY TO COMMIT
