# EasySchematic MCP Output Schemas — Proposal Packet

## 1. Executive recommendation

Add meaningful `outputSchema` contracts to the existing 27 LibraryDoctor MCP tools in one narrow follow-up change.

This is worth doing because the server already returns `structuredContent` for every successful tool call. The missing piece is discovery metadata: `mcpServer.ts` registers descriptions, input schemas, and annotations, but no output schemas. Adding the contracts will remove ChatGPT's **Output schema recommended** advisory, give models stable result landmarks, and make MCP clients validate successful structured results.

The recommended implementation is deliberately shallow where outputs are simple and deeper only where decision/status semantics matter. Do not add vague root-level `z.record(z.string(), z.unknown())` schemas merely to remove the badge.

## 2. Current repository state

- Repository: `C:/Users/seanl/Documents/codex/EasySchematic/repo`
- Branch: `feature/jetbuilt-project-library-gap-phase5`
- HEAD: `dc2ee51128f486ea5879ba540f732d0e6f4676b5`
- Current MCP tool count: 27
- MCP SDK: `@modelcontextprotocol/sdk ^1.29.0`
- Existing schema library: Zod
- Existing unrelated untracked packets, artifacts, tests, and device JSONs remain out of scope and must be preserved.
- This packet proposes work only; it does not implement, commit, push, deploy, migrate, or reconnect anything.

## 3. What the ChatGPT advisory means

The orange **Output schema recommended** label is not a runtime error. Tools remain callable.

It appears because each discovered MCP tool has an `inputSchema` but no `outputSchema`. ChatGPT can read the JSON result, but it has no advertised machine-readable contract describing the result before invocation.

## 4. Existing implementation evidence

`tateside-api/src/mcpServer.ts` already centralizes all registration through one `register` helper.

Successful calls already return both forms required for structured MCP output:

```ts
{
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
}
```

The installed SDK supports `outputSchema` directly on `server.registerTool(...)`. Its client automatically validates `structuredContent` when an output schema is advertised.

Error calls already return `isError: true` plus text content. MCP does not require an error result to match the successful output schema, so the existing fail-closed error path does not need to be redesigned.

## 5. Goals

1. Advertise a truthful object output schema for all 27 tools.
2. Preserve every current tool name, input, annotation, behavior, and result payload.
3. Remove the ChatGPT output-schema advisory after MCP refresh.
4. Improve model interpretation of pagination, status, evidence, proposal-only safety, and project-gap decisions.
5. Catch accidental output-contract drift in tests.

## 6. Non-goals

- No 28th tool.
- No tool renames or input changes.
- No database or migration changes.
- No REST, frontend, Library Doctor queue, or proposal-review changes.
- No canonical template, taxonomy, alias, schematic, proposal-status, or Jetbuilt mutation changes.
- No new dependency or JSON-schema generator.
- No duplicate response DTO layer.
- No attempt to claim speed, reliability, or reasoning improvements that output schemas do not provide.
- No ChatGPT delete/re-add or OAuth reconnect unless a separate authorization failure occurs.

## 7. Proposed contract strategy

Use the already-installed Zod version and pass a tool-specific output schema through the existing registration helper.

Every successful schema should require stable, meaningful top-level fields. Reuse small local fragments for repeated shapes:

- successful result: `success: z.literal(true)`;
- read result: `readOnly: z.literal(true)` where that field already exists;
- bounded result: `items`, `count`, `total`, `limit`, `offset`, `hasMore`;
- warnings: `z.array(z.string())`;
- nullable stored fields: explicit `.nullable()`;
- proposal-only results: current `proposalOnly`, `applied`, status, IDs, and warnings;
- project-gap statuses: the existing seven-value enum.

Use `.passthrough()` or `z.unknown()` only for fields that are intentionally open-ended today, such as arbitrary proposal field values, stored template metadata, taxonomy change payloads, or caller-supplied evidence payloads. Stable decision fields and counts should not be weakened to unknown records.

## 8. Coverage plan for all 27 tools

| Group | Tools | Proposed depth |
| --- | --- | --- |
| Taxonomy reads | `list_taxonomy_values`, `list_taxonomy_aliases`, `get_taxonomy_value`, `preview_taxonomy_registry_change` | Exact envelope, pagination, identity/status/change-key fields; open payload values only where already dynamic |
| Template/library reads | `search_templates`, `get_template`, `get_template_issues`, `get_library_audit`, `preview_template_taxonomy`, `get_library_coverage` | Exact result envelope and stable counts; reusable template/audit fragments |
| Intelligence reads | `list_manufacturers`, `get_manufacturer_summary`, `find_related_templates`, `get_classification_conflicts`, `get_library_issue_clusters`, `get_taxonomy_coverage_gaps`, `get_suspicious_templates`, `get_template_triage_bundle` | Exact pagination, scoring, identity, conflict, and triage landmarks; deeper triage status fields |
| Proposal writes | `create_library_doctor_proposal`, `create_library_doctor_new_template_proposal`, `create_taxonomy_registry_change_proposal` | Deep proposal-only safety fields, IDs, status, warnings, validation/manual-review result branches |
| Jetbuilt discovery | `get_jetbuilt_library_coverage_summary`, `get_jetbuilt_library_candidates`, `get_jetbuilt_library_candidate`, `get_jetbuilt_candidate_usage`, `get_jetbuilt_candidate_cooccurrence` | Exact candidate identity, ranking/usage counts, pagination, cohort/stage summaries, warnings |
| Phase 5 project gap | `get_jetbuilt_project_library_gap_analysis` | Deep schema for run identities, project context, seven candidate statuses, candidate evidence, summaries, query counts, acquisition metadata, versions, and warnings |

All 27 tools receive a schema. Schema precision is selective; the most decision-heavy tools receive the deepest contracts.

## 9. Minimal implementation shape

Keep output schemas beside the existing registrations in `tateside-api/src/mcpServer.ts`. This avoids a parallel contract module and makes input/output review happen at the same boundary.

Change the helper from conceptually:

```ts
register(name, inputSchema)
```

to:

```ts
register(name, inputSchema, outputSchema)
```

and pass `outputSchema` into the existing `server.registerTool` config. The callback and `result()` helper should remain unchanged unless a real schema mismatch is found.

Do not refactor the registrations into factories, classes, generated files, or a new schema framework.

## 10. Expected files

| File | Change |
| --- | --- |
| `tateside-api/src/mcpServer.ts` | Add reusable Zod result fragments, tool-specific output schemas, and pass them through `register` |
| `tateside-api/mcpHttp.local.test.mjs` | Assert all 27 discovered tools advertise object output schemas and representative calls validate through the SDK client |

Only add another existing test file if the Phase 5 history fixture is required to validate the full project-gap success payload. Do not create a new test framework or fixture layer.

## 11. Validation plan

Minimum required checks:

1. `npm run tateside:api:build` passes.
2. Streamable HTTP discovery returns exactly 27 tools.
3. Every discovered tool has `outputSchema.type === "object"`.
4. Existing representative read, paginated read, intelligence, existing-template proposal, and new-template proposal calls pass SDK output validation.
5. A Phase 5 project-gap success fixture passes SDK output validation.
6. An invalid input/tool execution still returns `isError: true`; it is not forced through the success schema.
7. Tool count, names, input schemas, read-only annotations, mutation behavior, and JSON text content remain unchanged.
8. Existing MCP HTTP, stdio, LibraryDoctor, Jetbuilt history, and Phase 5 focused tests pass.
9. `git diff --check` passes.

## 12. Acceptance criteria

- ChatGPT no longer shows **Output schema recommended** on any LibraryDoctor tool after Refresh.
- The tool surface remains exactly 27.
- `get_jetbuilt_project_library_gap_analysis` advertises the seven existing candidate statuses and stable run/proposal identities.
- Proposal tools explicitly advertise proposal-only/unapplied outcomes and validation/manual-review fields.
- Paginated tools advertise `items`, `count`, `total`, `limit`, `offset`, and `hasMore` consistently.
- Successful `structuredContent` validates against its advertised schema.
- Error results remain usable and fail closed.
- No schema is a badge-only root-level unknown object.
- No new dependency, migration, endpoint, permission, write authority, or external-system behavior is introduced.

## 13. Expected benefit

The benefit is modest but real:

- models can plan around known result keys before calling a tool;
- nested status/evidence results are less likely to be misread;
- chained calls can select identifiers and pagination fields more reliably;
- MCP clients detect contract drift earlier;
- ChatGPT removes the advisory badge.

This will not make database queries faster, improve tunnel uptime, change authentication, or make weak evidence authoritative.

## 14. Main risks and controls

| Risk | Control |
| --- | --- |
| Overly strict schema rejects valid current output | Build schemas from real return paths and validate representative fixtures through the SDK client |
| Vague schema removes badge without helping the model | Require stable semantic fields; reserve unknown records for genuinely dynamic values |
| Output implementation later drifts | Keep schemas at the registration boundary and retain discovery/call validation tests |
| Large duplicated candidate definitions | Reuse small local Zod fragments, especially the Phase 5 candidate schema |
| Error path accidentally forced through success schema | Preserve `isError: true` behavior and add one regression check |

## 15. Rollout proposal

1. Implement on a narrow follow-up branch from the Phase 5 head.
2. Run the focused MCP/Phase 5 checks and API build.
3. Commit and push only the reviewed schema/test diff.
4. Restart the local MCP process.
5. In ChatGPT, open LibraryDoctor and click **Refresh**.
6. Confirm 27 tools remain and the advisory is absent.

Deleting/re-adding LibraryDoctor is not part of the normal rollout because output-schema discovery refresh does not invalidate OAuth.

## 16. Final verdict

**RECOMMENDED AS A NARROW FOLLOW-UP.**

Implement accurate output contracts for all 27 tools, but spend detailed schema effort only on fields that materially guide model decisions. The current shared registration and `structuredContent` path already provide the shortest safe route; no transport, database, UI, or connector redesign is justified.
