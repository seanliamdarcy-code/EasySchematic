---
name: jetbuilt-project-library-gap
description: >
  Use this skill when implementing, repairing, or validating EasySchematic's
  project-first Jetbuilt workflow: resolve one exact P-number, analyze its full
  BOM against the canonical library and proposal queue, acquire only that exact
  cached-index project when absent, and create quality-gated pending Library
  Doctor proposals without stripping valid data or applying anything.
license: MIT
metadata:
  author: OpenAI
  version: "1.0"
---

# Jetbuilt project-first library-gap golden path

Use one bounded project analysis, external official-source research only for
unresolved hardware, and individual pending-only proposals. Preserve the core
invariant: `accepted != applied`.

**Failure pattern:** An Epson-style complete proposal fails validation, then a
retry strips valid ports or other verified fields just to enter the queue.
Reject that fallback: preserve the entire attempted payload and exact issues as
`validation-failed` / `needs-manual-review`, insert no proposal, and continue
independent candidates safely.

**Verified by:** `npm run tateside:api:build`; `npm test` (24 files, 188 tests);
`npm run jetbuilt:history:test` (15 tests); the focused Node suite (28 tests);
and `npm run build`. The implementation is locally verified, not deployed.

## Repository boundary

- Work from `C:/Users/seanl/Documents/codex/EasySchematic/repo`.
- `C:/Users/seanl/Documents/codex/EasySchematic` is the workspace root, not the
  repository root. Run Git, npm, and path-relative commands from `repo`.
- Do not infer production availability from local success. The migration and
  narrow proposal-identity route still require the normal reviewed deployment.

## Source map

Read these before changing the flow; reuse them rather than building a parallel
pipeline:

- History schema: `tateside-api/jetbuilt-history-migrations/0001_history_store.sql`
- Candidate-result migration: `tateside-api/migrations/0011_jetbuilt_project_gap_candidate_results.sql`
- Bounded analysis/acquisition: `tateside-api/src/jetbuiltProjectLibraryGap.ts`
- Exact history storage/lookups: `tateside-api/src/jetbuiltHistoryStore.ts`
- GET-only project sync: `tateside-api/src/jetbuiltHistorySync.ts`
- Cohort semantics: `tateside-api/src/jetbuiltHistoryCohorts.ts`
- Schematic relevance V1: `tateside-api/src/jetbuiltHistoryLineClassification.ts`
- Existing identity/ranking helpers: `tateside-api/src/jetbuiltLibraryDiscovery.ts`
- Proposal gates/failure capture: `tateside-api/src/libraryDoctorNewTemplate.ts`
- Pending queue/evidence/history: `tateside-api/src/libraryDoctorStore.ts`
- MCP implementation/registration: `tateside-api/src/mcpLibrary.ts`,
  `tateside-api/src/mcpServer.ts`, and `tateside-api/src/mcpHttpServer.ts`
- Narrow identity endpoint: `tateside-api/src/server.ts`
- Configuration/env mapping: `tateside-api/src/config.ts`
- Regression suites: `tateside-api/jetbuiltHistory.local.test.mjs`,
  `tateside-api/mcpHttp.local.test.mjs`,
  `tateside-api/mcpLibrary.local.test.mjs`,
  `tateside-api/libraryDoctorNewTemplate.local.test.mjs`, and
  `tateside-api/schematicRoutes.local.test.mjs`

## Procedure

1. Confirm the repository boundary and inspect the existing flow end to end.
   Preserve unrelated work and do not add a second analysis or proposal path.

2. Resolve only an exact normalized project number or exact Jetbuilt project ID.
   Accept formatting-equivalent P-numbers, return structured `project-not-found`
   or `ambiguous-project`, and never use project names or fuzzy matches as
   authoritative identity.

3. Analyze the locally stored project in five history queries:

   1. exact project lookup;
   2. rooms for that project;
   3. systems for that project;
   4. all project line items, joined to rooms, systems, and stored canonical links;
   5. historical line items needed for outside-project usage.

   Load current canonical templates once and check proposal identities in one
   request. Group only exact normalized `manufacturer::model` identities. Reuse
   `jetbuilt-schematic-relevance-v1`; unknown rows stay visible for research.
   Do not add broad substring exclusions or fuzzy merges.

4. If the exact project is missing locally, use exact cached-index acquisition:
   resolve its ID only from the existing cached Jetbuilt project index. Call the existing sync
   with that one ID and a one-project limit. The minimum acquisition is five
   GETs: project detail, rooms, systems, items, and versions; pagination may add
   bounded collection GETs. Persist through the existing immutable snapshot and
   normalized history schema. A local rerun must make zero Jetbuilt requests.
   Never refresh/list all projects, broadly backfill, or make a Jetbuilt write.

5. Keep the MCP surface bounded. `get_jetbuilt_project_library_gap_analysis`
   should return the full project context and statuses in one call, including
   `exact-canonical-match`, `known-non-schematic`, `already-proposed`,
   `unmatched-hardware-candidate`, `possible-identity-variant`,
   `needs-manual-review`, and `insufficient-identity`. Do not add candidate-detail
   or run-status tools unless the bounded payload demonstrably stops being enough.

6. Treat unmatched identities as research candidates, not proof of missing
   hardware. Research externally against official manufacturer sources. Submit
   complete candidates individually through
   `create_library_doctor_new_template_proposal`; leave every created proposal
   pending and unapplied.

7. Enforce every proposal gate before insertion:

   - zero exact canonical collision;
   - no existing exact identity, declared exact alias, or generation-key match;
   - high classification confidence and explicit identity verification;
   - at least one official HTTP(S) evidence reference;
   - complete physical ports, or explicit not-applicable;
   - complete dimensions, or explicit unavailable;
   - taxonomy validation;
   - explicit confirmation that no valid data was omitted.

8. On validation or store failure, create no proposal. Return the exact issues,
   `candidateStatus: needs-manual-review`, and the complete `attemptedTemplate`;
   with project context, persist it as `validation-failed`. Never remove ports,
   dimensions, evidence, taxonomy, identity, or any verified field. Network
   failures remain retryable and must not erase earlier candidate results.

9. Preserve resumability through the deterministic run identity, exact proposal
   identities, aliases, and generation keys. Reruns skip completed proposals and
   surface prior failed results; one failed candidate must not roll back other
   independently completed candidates. Do not wrap external research in one
   opaque batch transaction and do not add a blind bulk-proposal tool.

## Environment names

Record or request only these names, never their values:

- `TATESIDE_JETBUILT_HISTORY_DB_PATH`
- `JETBUILT_API_KEY`
- `JETBUILT_API_BASE_URL`
- `JETBUILT_INDEX_PATH`
- `TATESIDE_DB_PATH`
- `TATESIDE_DATA_DIR`
- `TATESIDE_MCP_LIBRARY_ENABLED`
- `TATESIDE_MCP_HTTP_ENABLED`
- `TATESIDE_LIBRARY_DOCTOR_PROPOSAL_API_URL`
- `TATESIDE_LIBRARY_DOCTOR_PROPOSAL_API_TOKEN`
- `TATESIDE_LIBRARY_DOCTOR_PROPOSAL_TOKEN`

The proposal API token is valid for the narrow proposal sink/identity contract;
do not assume it can read the normal deployed proposal-detail route.

## Validation

Run from the repository root in this order:

```powershell
npm run tateside:api:build
npm test
npm run jetbuilt:history:test
npm run tateside:api:build
node --test tateside-api/mcpHttp.local.test.mjs tateside-api/mcpLibrary.local.test.mjs tateside-api/libraryDoctorNewTemplate.local.test.mjs tateside-api/schematicRoutes.local.test.mjs
npm run build
git diff --check
```

Expected verified baseline: API build passes; 188 Vitest tests pass; 15 history
tests pass; 28 focused Node tests pass; production build passes with only the
existing Vite chunk-size advisory. Also run ESLint only on changed files; do not
expand the task into unrelated repository-wide lint cleanup.

The Epson-style regression must prove an invalid complete port taxonomy value
returns the exact validation issue, preserves the unchanged complete attempted
payload, inserts zero proposals, persists manual-review state, and lets other
candidates continue.

## What didn't work

- Running from the workspace root fails because the actual Git/npm repository is
  the nested `repo` directory.
- Using the proposal service credential to GET the current deployed proposal
  details returned HTTP 401; diagnose through the narrow identity endpoint or a
  disposable local fixture instead of claiming access to the original payload.
- Assuming arbitrary local project history is available is false: the validation
  history contains only `P-4940`. For another P-number, use exact cached-index
  acquisition only. Never repair this with a broad index refresh or backfill.
- Retrying an Epson-style rejection after stripping ports is data loss, not
  recovery. Preserve the complete payload and stop that candidate.

## Production caveat

Local verification does not prove production support. No deployment, production
migration, restart, production mutation, or live broad acquisition was performed.
Do not claim the one-hit production workflow until the migration and narrow
proposal-identity endpoint have passed reviewed deployment and a bounded,
non-sensitive live project check.
