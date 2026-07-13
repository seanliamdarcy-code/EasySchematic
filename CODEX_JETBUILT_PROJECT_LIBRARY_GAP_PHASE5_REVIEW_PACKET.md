# Jetbuilt Project → Library Gap → Pending Proposals — Phase 5 Review Packet

## 1. Executive verdict

Phase 5 is implemented and locally verified. One bounded MCP analysis now resolves an exact project, assembles its whole stored BOM, groups exact normalized `manufacturer::model` identities, checks the current canonical library and proposal identities in batches, reuses `jetbuilt-schematic-relevance-v1`, and returns only unresolved candidates for external research. Proposal creation remains individual and pending-only.

The critical failure rule is enforced: a rejected complete proposal is returned as `needs-manual-review`, and its complete attempted payload plus exact validation issues are persisted as `validation-failed`. Valid ports or other fields are never stripped automatically.

Production is not confirmed because this task forbids deployment. The code, migration, narrow proposal-identity endpoint, and tests are ready for final review.

## 2. Repository/branch/HEAD state

- Repository root: `C:/Users/seanl/Documents/codex/EasySchematic/repo`
- Starting branch: `feature/library-doctor-new-template-proposals-phase4`
- Starting/current HEAD: `042bfbd7766a9872de2f5050232cc119d8468463`
- Relevant fetched origin head: `origin/feature/library-doctor-new-template-proposals-phase4` at the same SHA
- New branch: `feature/jetbuilt-project-library-gap-phase5`
- Tracked state before Phase 5: clean
- Existing untracked review packets, artifacts, Playwright files, device JSONs, and test results: preserved
- Visual proposal-preview work: safely committed and fetched at the starting SHA
- No reset, clean, stash, rebase, commit, push, or force push occurred

## 3. Existing project-level capabilities found

- `tateside-api/jetbuilt-history-migrations/0001_history_store.sql`: normalized projects, rooms, systems, line items, immutable raw snapshots, line-item presence, canonical links, and checkpoints.
- `tateside-api/src/jetbuiltHistoryStore.ts`: exact history ingest, raw snapshot hashing, local project search, exact canonical-link refresh, and usage reads.
- `tateside-api/src/jetbuiltHistorySync.ts`: bounded GET-only project/detail/rooms/systems/items/versions acquisition.
- `tateside-api/src/jetbuiltHistoryCohorts.ts`: explicit stage/cohort semantics.
- `tateside-api/src/jetbuiltHistoryLineClassification.ts`: exact-rule `jetbuilt-schematic-relevance-v1` classifier.
- `tateside-api/src/jetbuiltLibraryDiscovery.ts`: normalized candidate grouping, historical usage, ranking, and current Phase 3 tools.
- `tateside-api/src/mcpLibrary.ts` and `mcpServer.ts`: shared local/HTTP MCP registration.
- `tateside-api/src/libraryDoctorNewTemplate.ts`: validated new-template proposal-only path and deterministic generation keys.
- `tateside-api/src/libraryDoctorStore.ts`: pending queue, evidence JSON persistence, immutable history, and accepted-not-applied semantics.

## 4. Gaps found

- Existing `searchHistoryProjects` used substring matching, so it could not be authoritative exact project lookup.
- Phase 3 discovery was history-wide and required candidate-by-candidate MCP calls.
- The local validation DB contains only one project (`P-4940`), not arbitrary projects.
- Exact project acquisition accepted Jetbuilt IDs, but no project-number-to-ID bridge existed for MCP.
- MCP could not query proposal identities through the proposal-only remote credential, so current remote duplicates could be missed.
- Caller declarations for identity review, evidence provenance, port completeness, dimensions completeness, and no-data-omission were not mandatory creation gates; the backend can validate structure but cannot independently prove those research claims.
- Failed complete payloads were not persisted as resumable candidate results.
- The original Epson failed request body/error is not available locally, and the current deployed GET route requires a user identity; the proposal service credential received HTTP 401 for diagnostic reads.

## 5. Implemented architecture

`tateside-api/src/jetbuiltProjectLibraryGap.ts` contains the one bounded project analysis and exact cached-index acquisition. One new migration stores only per-run candidate success/failure records. The existing new-template proposal function now applies the quality gates and records complete failures. The proposal sink exposes one credential-scoped, read-only identity endpoint containing only proposal identities/aliases and candidate results.

No bulk proposal creator, run-status MCP tool, apply tool, canonical writer, taxonomy writer, alias applier, schematic writer, arbitrary SQL surface, or Jetbuilt write path was added.

## 6. User-facing one-hit workflow

“One hit” means Sean gives one prompt. ChatGPT internally:

1. Calls `get_jetbuilt_project_library_gap_analysis` once.
2. Researches only unresolved candidates against official sources.
3. Submits each complete candidate individually through `create_library_doctor_new_template_proposal`.
4. Leaves every created item pending and unapplied.

It is not one atomic backend transaction, and it does not pretend external research occurred in the backend.

## 7. Project lookup behaviour

- Exact normalized project number: supported (`P-12345`, `P12345`, and spacing/case-equivalent forms).
- Exact Jetbuilt project ID: supported.
- Project name: retained for returned context but deliberately not an authoritative lookup mode.
- No match: structured `project-not-found`.
- Multiple normalized matches: structured `ambiguous-project`; no silent selection.
- Maximum project size: 5,000 line items; larger projects fail rather than truncate.

## 8. On-demand project acquisition behaviour

If the exact project is absent locally and acquisition is enabled:

- Resolve only an exact project number/ID from the existing cached Jetbuilt index.
- Fetch exactly that project detail, rooms, systems, items, and versions.
- Use GET-only enforcement and existing finite retry/rate-limit behavior.
- Store immutable raw snapshots and normalized history records through the existing schema.
- Never list/backfill all projects and never make a Jetbuilt write.
- A locally present rerun makes zero Jetbuilt requests.
- A cached-index miss returns `project-not-found-in-cached-index`; it does not claim the project is absent from Jetbuilt, and it does not trigger a broad scan or refresh.

Minimum request count is five; pagination may add collection requests. Synthetic acquisition, interruption, and resume are proved. Live on-demand acquisition was not run because the review shell had no Jetbuilt API credential and broad live work was prohibited.

## 9. Project BOM assembly

The analysis performs one project lookup, one room query, one system query, one complete project line-item query, and one historical-usage query. All line items are counted. Rooms/systems are joined deterministically by stored IDs.

## 10. Candidate identity grouping

Identity remains exact normalized `manufacturer::model` using the existing `normalizedLookupKey`. Formatting-equivalent rows group; incomplete rows remain separately visible as `insufficient-identity`. No fuzzy merge or substring identity authority exists.

## 11. Schematic relevance handling

The implementation reuses `jetbuilt-schematic-relevance-v1` unchanged. Exact known exclusions are removed; unknowns remain visible for research. Real `P-4940` evidence suggests exact V2 review candidates: `Tateside::Discount`, `Tateside::Rack Sundries`, and the observed generic cable/order-code row. They were not silently added to V1.

## 12. Canonical exact-match handling

Current templates are loaded once and indexed by exact normalized manufacturer plus model/label. Stored historical canonical links are returned as evidence but do not override current canonical truth. Exact current search-term matches are labelled `possible-identity-variant`, not silently merged.

## 13. Existing proposal detection

One proposal identity read checks all statuses by:

- exact normalized manufacturer/model;
- exact explicitly declared identity alias;
- default deterministic generation key;
- repository-conventional Jetbuilt generation key.

This detects the existing Neat order-code alias pattern and prevents recreating rejected, accepted, pending, manual-review, or superseded identities. Intel, Epson, and Neat IDs are never created, accepted, or applied by this phase.

## 14. Project-gap MCP tool contract

Input:

```json
{ "projectNumber": "P-12345", "allowOnDemandAcquisition": true }
```

Output includes project ID/name/stage, cohort semantics, complete counts, rooms, systems, candidate-by-candidate status and usage, outside-project usage, current exact collisions, possible exact variants, existing proposals, prior failed result, generation key, run context, query/request counts, and version identities. `projectSourceFingerprint` and the canonical snapshot form the stable run identity; `proposalStateIdentity` is a separate live overlay identity excluded from the run key.

Statuses: `exact-canonical-match`, `known-non-schematic`, `already-proposed`, `unmatched-hardware-candidate`, `possible-identity-variant`, `needs-manual-review`, and `insufficient-identity`.

## 15. Candidate-detail tool contract

No new candidate-detail tool was added. The bounded main payload already supplies the required candidate context, avoiding a second round of per-candidate history calls.

## 16. Call-count reduction

- Before: Phase 3 commonly required coverage, candidate list, candidate detail, usage, and co-occurrence calls per candidate.
- After: one project-gap MCP call.
- Local internals with remote proposal state: five history queries, one canonical query, one proposal identity request.
- On-demand acquisition: minimum five Jetbuilt GETs once; local rerun: zero.
- Research and proposal insertion remain intentionally candidate-specific.

## 17. Resumability/idempotency

Run identity is SHA-256 of a stable exact-project/BOM source fingerprint + analysis version + canonical snapshot identity. The source fingerprint covers stable project fields, rooms, systems, every line item, quantities, and room/system relationships while excluding timestamps and sync bookkeeping. Re-analysis is deterministic for identical source/canonical state; source or canonical changes cannot inherit a prior run's validation failure. Proposal state is deliberately a separately versioned live overlay, so a new/reviewed proposal may change candidate status and `proposalStateIdentity` without changing the run key. Generation keys and exact proposal identities prevent recreation. Complete validation failures persist by run/candidate with the attempted payload and exact issues. A failed candidate does not roll back completed independent proposals. No giant transaction spans research candidates.

## 18. Quality gates

Creation now requires:

- zero exact canonical collision;
- no identical existing generation key;
- `classificationConfidence: high`;
- caller declaration that identity research was verified;
- caller declaration that at least one HTTP(S) evidence reference is official;
- caller declaration that physical ports are complete or not applicable;
- caller declaration that dimensions are complete or unavailable;
- taxonomy validation;
- caller confirmation that no valid data was omitted.

Failure creates no proposal and returns/persists `needs-manual-review`/`validation-failed`.

The backend independently validates the template/taxonomy shape, exact collisions, classification-confidence enum, evidence URL protocol/type marker, required dimensions for a caller-declared complete set, and ports-versus-declaration consistency. It does not prove manufacturer-domain ownership or independently establish research completeness.

## 19. Evidence handling

`evidenceRefs` already traversed MCP schema → remote JSON body → `createLibraryDoctorNewTemplateProposal` → `createLibraryDoctorProposal` → `evidence_refs_json` → proposal API → Library Doctor UI/properties UI. Existing UI tests prove display. The Intel zero-evidence proposal demonstrates the missing creation gate, not a storage/UI loss. The new gate requires a caller-marked official HTTP(S) reference, while explicitly avoiding any claim that the backend verified manufacturer ownership of the domain.

## 20. Epson failure diagnosis

The original full request body/error is unavailable; its exact cause cannot honestly be claimed. Current deployed read access returned HTTP 401 with the proposal-only credential, and no Intel/Epson copy exists in the local research DB.

A disposable representative complete Epson EB-810E fixture reproduced an HTTP-400-class validation failure: `connectorType: "3.5mm"` is rejected as unknown (the current taxonomy uses `trs-eighth`). The regression proves the required behavior: exact issue returned, complete two-port attempted template preserved unchanged, zero proposal insertion, candidate marked manual-review, and other candidates continue safely. The real pending Epson proposal was not mutated.

## 21. Failure behaviour

Validation/store failures are converted into structured results with exact issues, `candidateStatus: needs-manual-review`, and `attemptedTemplate`. With project context they are persisted as `validation-failed`. Network failures remain retryable and cannot erase existing candidate results or proposals.

## 22. No-data-stripping guarantee

There is no fallback that removes ports, dimensions, evidence, taxonomy, identity, or any other verified field. The regression deep-compares the caller payload before/after and the persisted attempted payload.

## 23. Real/synthetic project validation

Real local `P-4940`, redacted:

- 18 BOM lines; 17 identities; 10 rooms; 1 system.
- 1 exact current canonical identity.
- 4 exact V1 non-schematic exclusions.
- 12 unresolved identities.
- 0 Jetbuilt requests/writes and 5 history queries.
- No project/client name, address, contact, or commercial value is included in this packet/artifact.

Synthetic `P-12345` proves all statuses, exact grouping, room/system counts, alias proposal detection, deterministic source/canonical identity, independent proposal overlay identity, stale-failure isolation, not-found/ambiguous behavior, and no external mutation. Synthetic `P-54321`/`P-FAIL` prove exact acquisition, interruption, and resume; `P-NOT-CACHED` proves bounded cached-index misses remain explicitly inconclusive.

## 24. Tests added

Direct coverage includes exact/normalized lookup, not found, inconclusive cached-index miss, ambiguity, complete BOM assembly, identity grouping, room/system counts, V1 relevance-classifier reuse, exact canonical match, exact exclusions, unmatched candidates, proposal alias/generation duplicate detection, deterministic rerun, add/remove line identity changes, quantity and relationship identity changes, canonical identity changes, separate proposal overlay changes, stale persisted-failure isolation, interrupted acquisition/resume, independent candidate completion, persisted validation failure, no stripping, honest caller-declaration wording, evidence preservation/requirement, port completeness, representative Epson rejection, and zero canonical/taxonomy/schematic/Jetbuilt/apply mutation.

## 25. Exact test results

- `npm run tateside:api:build`: passed.
- `npm test`: 24 files, 188 tests passed.
- `npm run jetbuilt:history:test`: 15 tests passed.
- Focused MCP/library/routes/new-template Node suite: 29 tests passed.
- `npm run build`: passed; only the existing Vite chunk-size advisory appeared.
- Changed-file ESLint: passed with no issues.
- `git diff --check`: passed.

## 26. MCP tool count before/after

- Before: 26 registered tools.
- After: 27 registered tools.
- Added: `get_jetbuilt_project_library_gap_analysis` only.

## 27. Security behaviour

Streamable HTTP, loopback enforcement, Cloudflare Access fail-closed behavior, local canonical research DB, narrow proposal-only sink, and no apply/promote surface remain. The new proposal identity endpoint requires the existing proposal service credential and returns only proposal identity/alias/status/generation data plus candidate results. No arbitrary SQL or external write authority was added.

## 28. Production confirmation

Not performed. No deploy, production mutation, restart, or production migration occurred. The remote identity endpoint and candidate-result migration must pass normal reviewed deployment before production one-hit support is claimed.

## 29. Jetbuilt request/write count

- Real local validation: 0 requests, 0 writes.
- Synthetic exact acquisition: 5 GETs for the first run, 0 on local rerun, 0 writes.
- No broad backfill.

## 30. Canonical/template/taxonomy/schematic before-after counts

Read-only real validation:

- Active canonical templates: 1108 → 1108.
- Taxonomy values: 0 → 0 (static fallback remains effective).
- Taxonomy aliases: 0 → 0.
- Saved schematics: 19 → 19.
- Real proposals created/accepted/applied: 0/0/0.
- Jetbuilt projects/rooms/systems/lines: 1/10/1/18 unchanged.

## 31. Remaining limitations

- Production deployment/route availability is unverified by constraint.
- Live on-demand acquisition is unverified in this shell; synthetic GET-only behavior is proved.
- The original Epson request/error is unavailable, so only a representative validator cause is proved.
- V1 intentionally leaves exact Discount/Rack Sundries/cable false positives visible pending reviewed V2 rules.
- Exact canonical search-term matches remain possible variants requiring review, not authoritative aliases.
- External official research still belongs to ChatGPT and may require multiple web requests.

## 32. Recommended next step

Final-review the diff, then deploy the API migration and narrow proposal-identity endpoint through the normal reviewed path. After deployment, restart only through that approved release, confirm the new MCP tool against a non-sensitive real P-number, and run one candidate with a complete official payload. Do not backfill broadly.

## 33. Exact Git diff summary

Implementation changes: nine tracked files modified, two implementation files added, plus this untracked review packet, the requested untracked JSON artifact, and one harvested project-local workflow skill. No dependency, lockfile, frontend production source, canonical data, taxonomy data, or schematic file changed.

## 34. Exact final Git status

Branch: `feature/jetbuilt-project-library-gap-phase5`; HEAD remains `042bfbd7766a9872de2f5050232cc119d8468463`.

Phase 5 tracked modifications:

- `tateside-api/jetbuiltHistory.local.test.mjs`
- `tateside-api/libraryDoctorNewTemplate.local.test.mjs`
- `tateside-api/mcpHttp.local.test.mjs`
- `tateside-api/schematicRoutes.local.test.mjs`
- `tateside-api/src/libraryDoctorNewTemplate.ts`
- `tateside-api/src/mcpHttpServer.ts`
- `tateside-api/src/mcpLibrary.ts`
- `tateside-api/src/mcpServer.ts`
- `tateside-api/src/server.ts`

Phase 5 untracked files:

- `tateside-api/migrations/0011_jetbuilt_project_gap_candidate_results.sql`
- `tateside-api/src/jetbuiltProjectLibraryGap.ts`
- `CODEX_JETBUILT_PROJECT_LIBRARY_GAP_PHASE5_REVIEW_PACKET.md`
- `artifacts/jetbuilt-project-library-gap-phase5.json` (reported by Git under the already-untracked `artifacts/` directory)
- `.codex/skills/jetbuilt-project-library-gap/SKILL.md` (reported by Git under the already-untracked `.codex/` directory)

All pre-existing untracked packets, `.codex/` contents, `Device_JSONS/`, Playwright files, and `test-results/` remain present and untouched; only the new workflow skill was added under `.codex/skills/`.

## CAN SEAN NOW SAY THIS?

“Look up P-12345 and put any genuinely missing devices into my Library Doctor pending queue.”

1. Can ChatGPT find the exact project? **Yes in the implementation: local exact lookup or one exact cached-index acquisition. Production deployment not yet confirmed.**
2. Can it retrieve the whole BOM efficiently? **Yes: one bounded analysis, five history queries; five minimum GETs only when first acquiring.**
3. Can it identify exact canonical matches in one project-scoped analysis? **Yes.**
4. Can it exclude known non-schematic noise? **Yes for reviewed V1 exact rules; new observed false positives remain visible pending V2 review.**
5. Can it detect existing pending proposals? **Yes through exact identities, declared aliases, and generation keys once the narrow remote identity route is deployed.**
6. Can it return only unresolved real hardware for research? **It returns unmatched eligible identities, but unmatched remains triage—not proof of real hardware; ChatGPT must reject visible V1 false positives.**
7. Can ChatGPT research those candidates using official sources? **Yes, externally; the backend does not fabricate research.**
8. Can complete validated proposals be created individually? **Yes, pending-only, with mandatory gates.**
9. Can the workflow resume safely after interruption? **Yes: deterministic rerun, proposal duplicate detection, persisted validation failures, and interrupted acquisition resume are proved.**
10. Will a failed candidate remain unresolved instead of having valid data removed? **Yes; proved by the Epson-style regression.**
11. Will duplicate proposals be prevented? **Yes for exact identity, declared alias, and generation key; no fuzzy authority.**
12. Will everything remain pending and unapplied? **Yes. `accepted != applied` remains invariant.**

## IMPLEMENT NOW

Review and merge the project-gap tool, proposal identity endpoint, quality gates, and candidate-result migration together.

## PROJECT-FIRST WORKFLOW RECOMMENDATION

Use one project analysis, then external research and individual complete proposals.

## PROJECT LOOKUP RECOMMENDATION

Keep exact normalized project-number/ID lookup and exact cached-index acquisition; never silently choose an ambiguous result.

## LIBRARY GAP ANALYSIS RECOMMENDATION

Keep one bounded analysis with exact identity grouping and batch canonical/proposal checks.

## QUALITY GATE RECOMMENDATION

Retain all mandatory gates and fail the candidate instead of weakening payloads.

## EVIDENCE RECOMMENDATION

Require at least one official HTTP(S) reference and preserve all submitted evidence end-to-end.

## FAILURE HANDLING RECOMMENDATION

Persist complete attempted payloads and exact issues as `validation-failed`; continue independent candidates.

## MCP RECOMMENDATION

Keep the single new analysis tool; do not add blind bulk-proposal or apply/promote tools.

## RESUMABILITY RECOMMENDATION

Use deterministic run/generation identities plus the lightweight failed-candidate record; no opaque batch transaction.

## CLASSIFICATION V2 RECOMMENDATION

Review exact rules for Discount, Rack Sundries, and the observed generic cable/order-code identity separately; do not add substring rules.

## BACKFILL RECOMMENDATION

Defer broad backfill. Acquire only explicitly requested exact projects until operational evidence justifies more.

## SAVED SCHEMATIC LINKAGE RECOMMENDATION

Defer; Phase 5 does not need saved-schematic mutation or linkage.

## DEFER

Broad backfill, fuzzy/automatic identity merging, automatic aliases, bulk proposals, automatic acceptance/application, taxonomy mutation, and schematic mutation.

READY FOR FINAL REVIEW
