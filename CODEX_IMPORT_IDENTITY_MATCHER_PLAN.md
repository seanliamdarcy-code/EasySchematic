# REVISED PLAN: SAFE IMPORT IDENTITY MATCHING

## Purpose

Resolve curated commercial SKUs and regional model names to an existing
canonical DeviceTemplate without creating duplicate templates or treating
general library search terms as exact identities.

Examples:

- Yealink / A40-031 -> Yealink / MeetingBar A40
- Yealink / A50-031 -> Yealink / MeetingBar A50
- Shure / MXW1/O -> Shure / MXW1
- AUDAC / WP225/W -> AUDAC / WP225
- Bose / DM5C -> Bose Professional / DM5C

Required safety behaviour:

- One unique identity hit: already_in_library.
- More than one distinct template hit: possible_match.
- No hit: preserve the existing possible-match and port-reuse behaviour.
- General searchTerms never create an exact identity hit.
- An ambiguous result requires an explicit template choice in the UI.


## Why the original plan should change

1. Filtered searchTerms are not a safe exact-match source.

   The library contains discovery terms such as "4k", "12g", "20x20",
   "48MP", and "100V". Many satisfy a digit/SKU heuristic, but they are
   product properties rather than identities. A denylist would become an
   incomplete second classification system that needs continuous maintenance.

2. identityAliases already exists as Library Doctor proposal metadata, but
   it is not part of the runtime DeviceTemplate type. Make the explicit field
   canonical now instead of building a temporary heuristic bridge.

3. Existing collision handling is incomplete.

   quoteImport currently treats any non-empty canonical result as exact and
   selects the first template. Canonical collisions and alias collisions must
   use the same unique/ambiguous rule.

4. Existing possible-match UI cannot safely resolve ambiguity.

   It displays all candidates, but "use library match" later selects
   possibleMatches[0]. The selected template ID must be stored explicitly.

5. The checked-in device JSON does not currently contain all acceptance
   aliases. Confirm the staging data and curate the missing aliases before
   expecting the golden cases to pass.


## Scope

MVP:

- Add DeviceTemplate.identityAliases.
- Validate and persist it through the existing template JSON path.
- Add one shared identity index/resolver.
- Use the resolver in quote import and project gap analysis.
- Make ambiguous UI choices candidate-specific.
- Curate the small set of aliases required by the acceptance cases.
- Add focused tests.

Deferred:

- Heuristic inference of aliases.
- Matching ordinary searchTerms as exact identities.
- AI/fuzzy matching.
- Automatic template creation.
- A new status enum.
- Debug telemetry unless an operational problem demonstrates a need.
- Full historical canonical-link rematching.
- A new curator script; use the existing template update/import path.


## Data model

Add this optional field to DeviceTemplate:

  identityAliases?: string[];

Meaning:

- modelNumber: canonical manufacturer model.
- label: canonical display label; exact full-label matching remains valid.
- identityAliases: reviewed commercial SKU, regional model, or procurement
  spelling that is safe for exact identity resolution.
- searchTerms: UI discovery only; never an exact identity source.

Validation:

- Must be an array of non-empty strings when present.
- Apply the same entry-count and string-length limits as searchTerms.
- Trim entries and remove empty strings during normalization.
- Duplicate aliases within one template may be deduplicated after
  normalization.
- Do not reject cross-template collisions at write time. Existing data may
  collide, and runtime matching must remain safe. An audit warning can be
  added later if curation needs it.

Persistence:

- No database migration is needed because templates are stored as JSON in
  device_versions.template_json.
- Add the field to the TypeScript type and validation/normalization path.
- Preserve Library Doctor proposal metadata as-is; when a proposal is
  eventually applied to a canonical template, copy its reviewed
  identityAliases onto the DeviceTemplate.
- The current Library Doctor queue has no Apply action, so MVP data changes
  should use the existing reviewed template update/import workflow.


## Shared identity module

Suggested file:

  tateside-api/src/libraryIdentity.ts

Move normalizedLookupKey out of quoteImport.ts into this module and re-export
it from quoteImport.ts temporarily only if existing imports would otherwise
make the change unnecessarily broad.

Public surface:

  buildLibraryIdentityIndex(templates)
  resolveLibraryIdentity(index, manufacturer, model)
  normalizedLookupKey(manufacturer, model)

The resolver returns one of:

  { kind: "none" }

  {
    kind: "unique",
    template: DeviceTemplate,
    sources: IdentityMatchSource[]
  }

  {
    kind: "ambiguous",
    templates: DeviceTemplate[],
    sources: IdentityMatchSource[]
  }

IdentityMatchSource may be:

  "canonical-model"
  "canonical-label"
  "identity-alias"
  "manufacturer-alias"

Do not add matchSource to the public quote-import response. Convert sources
to the existing matchReason string at the call site.


## Key construction

For every template, index:

1. Canonical identities

   manufacturer + modelNumber
   manufacturer + label, when modelNumber exists

2. Explicit identities

   manufacturer + each identityAliases entry

3. Reviewed manufacturer equivalents

   For every equivalent manufacturer name, index the canonical model, full
   label, and explicit identity aliases.

Start with:

  ["QSC", "Q-SYS"]
  ["Bose", "Bose Professional"]

Represent manufacturer aliases as equivalence groups rather than manually
maintained forward and reverse maps. This prevents one-way alias drift.

Do not add Cisco/Meraki or any other pair without a concrete observed case
and a regression test.


## Normalization

Keep the existing deterministic rule:

- trim
- lowercase
- remove non-alphanumeric characters

Examples:

  "A40-031"          -> "a40031"
  "MXW1/O"           -> "mxw1o"
  "Bose Professional" -> "boseprofessional"

Do not add substring, token, prefix, edit-distance, or family matching to the
identity resolver. Existing possible-match and port-reuse logic already owns
soft similarity.


## Deduplication and collision policy

Deduplicate matches by stable template identity:

- Prefer template.id.
- For tests or unsaved templates without an ID, use the existing
  deviceType + label fallback.

The same template may be reached through modelNumber, label,
identityAliases, and a manufacturer equivalent. That remains one hit.

Resolve the union of all matching canonical and alias entries:

- Zero distinct templates -> none.
- One distinct template -> unique.
- More than one distinct template -> ambiguous.

Apply this rule to canonical collisions as well as alias collisions.
Never use templates[0] to auto-resolve an ambiguous result.

A canonical hit that conflicts with another template's explicit alias is
ambiguous. This deliberately exposes bad curated data instead of hiding it.


## Quote import integration

In quoteImport.ts:

1. Replace buildMatchContext.byLookupKey with the shared identity index.
2. Keep byModel and the existing soft matching/port-reuse logic unless the
   shared module already provides the same data without extra code.
3. Resolve each device from its manufacturer and model. Do not trust a
   caller-supplied normalizedLookupKey as the only lookup input.
4. Map results:

   unique:
     status = already_in_library
     exactMatch = resolved template
     possibleMatches = []

   ambiguous:
     status = possible_match
     exactMatch = null
     possibleMatches = every distinct candidate
     each reason = "Ambiguous library identity"

   none:
     preserve findPossibleMatches and findPortReuseCandidates

5. Keep Jetbuilt and PDF quote paths unchanged; both already route through
   inspectQuoteDevicesAgainstLibrary.

Suggested unique match reasons:

- "Exact manufacturer/model match in TateSide library"
- "Reviewed identity alias match in TateSide library"
- "Reviewed manufacturer alias match in TateSide library"


## Ambiguous-match UI fix

Current behaviour stores a generic "use_library_match" decision and later
uses item.possibleMatches[0]. Replace that with the selected candidate ID.

Minimal state shape:

  selectedPossibleMatchIds: Record<importItemKey, templateId>

UI behaviour:

- Render "Use this library device" on each candidate card.
- Selecting a candidate stores that candidate's ID.
- Highlight the selected card.
- "Research as missing" clears any selected candidate ID.
- Starting the schematic looks up the candidate by the stored ID.
- If the selected ID is absent or no longer present, leave the item
  unresolved and show the existing review error.

For a single possible match, the same candidate-specific control is used.
Do not maintain separate single-candidate and multi-candidate decision paths.


## Project gap analysis integration

Replace canonicalIndexes with the shared identity index/resolver.

For each candidate:

- unique -> exact-canonical-match
- ambiguous -> possible-identity-variant
- none -> preserve classification, proposal, validation-failure, and
  unmatched handling

Evidence:

- unique: currentCanonicalCollisionEvidence contains the selected template.
- ambiguous: possibleIdentityVariantEvidence contains every distinct
  candidate.

Update canonicalSnapshotIdentity to include sorted identityAliases.
Increment JETBUILT_PROJECT_LIBRARY_GAP_ANALYSIS_VERSION because result
classification changes.

Keep stored historical canonical_template_id reporting unchanged. This PR
does not rewrite canonical_template_links.


## History matcher decision

Do not silently change historical links in the MVP.

matchHistoryTemplates already requires exactly one canonical candidate before
writing a derived link. A follow-up may reuse resolveLibraryIdentity and bump
JETBUILT_HISTORY_MATCHER_VERSION after the recent-project sample proves the
curated aliases are safe.

That follow-up should explicitly re-run the derived matcher; it must not be
smuggled into deployment as an incidental side effect.


## Curated data changes

Confirm the canonical template IDs in the target staging snapshot, then add:

- MeetingBar A40: A40-031
- MeetingBar A50: A50-031
- MXW1: MXW1/O
- WP225: WP225/W

Do not add CIRA724I/W to CIRA7 without reviewed product evidence that they
are the same physical template. Until then it should remain possible or
missing.

DM5C needs only the Bose/Bose Professional manufacturer equivalence if the
canonical modelNumber is already DM5C.

Before saving:

- Search normalized aliases across all templates.
- Record any collision.
- Resolve collisions through curation rather than ordering.


## Focused tests

Shared resolver:

1. Unique explicit identity alias returns unique.
2. Manufacturer equivalent returns unique.
3. Combined manufacturer equivalent + identity alias returns unique.
4. Two templates sharing an identity alias return ambiguous.
5. Two canonical templates sharing a normalized identity return ambiguous.
6. One template reached through several keys is still one unique hit.
7. A noisy searchTerm such as "4k" does not produce an identity hit.
8. Empty or missing manufacturer/model returns none.

Quote import:

9. Yealink / A40-031 -> already_in_library / MeetingBar A40.
10. Yealink / A50-031 -> already_in_library / MeetingBar A50.
11. Shure / MXW1/O -> already_in_library / MXW1.
12. AUDAC / WP225/W -> already_in_library / WP225.
13. Bose / DM5C -> already_in_library / Bose Professional DM5C.
14. Ambiguous alias -> possible_match with all distinct candidates.
15. Samsung QM75C does not exact-match QM55C.
16. Existing canonical manufacturer/model matching still works.
17. Inspection remains read-only in SQLite.

UI:

18. Selecting the second of two candidates starts the schematic with the
    second template, not possibleMatches[0].
19. Research-as-missing clears a previously selected candidate.

Project gap:

20. Unique alias -> exact-canonical-match.
21. Ambiguous alias -> possible-identity-variant with all evidence.
22. Snapshot identity changes when identityAliases changes.

Keep these as focused additions to existing test files. Do not create a new
test framework or broad fixture system.


## Likely files

Required:

- src/types.ts
- tateside-api/src/validation.ts
- tateside-api/src/libraryIdentity.ts (new)
- tateside-api/src/quoteImport.ts
- tateside-api/src/jetbuiltProjectLibraryGap.ts
- src/components/ImportQuoteDevicesDialog.tsx
- src/__tests__/quoteImport.test.ts
- the existing project-gap test file
- the smallest existing UI test that can verify candidate selection

Data:

- reviewed canonical template JSON or staging template updates for the four
  confirmed SKU aliases

Avoid touching unrelated Library Doctor, proposal queue, taxonomy, bundle,
or research code.


## Implementation order

1. Add identityAliases type, validation, and normalization.
2. Add the shared resolver and its focused tests.
3. Wire quote import and add quote matcher cases.
4. Fix candidate-specific UI selection and test the second-candidate case.
5. Replace project gap canonicalIndexes and bump its analysis version.
6. Curate the confirmed staging aliases.
7. Run focused tests, then the normal test/build checks.
8. Run the recent-project sample and manually verify one Jetbuilt import.

One PR is sufficient. Split only if deployment policy requires code and
curated data to be reviewed separately.


## Verification

Automated:

- Run the quote import tests.
- Run project gap tests.
- Run the focused UI test.
- Run typecheck/build.
- Run the existing library audit.

Staging:

- Re-run recent-10 gap analysis.
- Compare exact, possible, and unmatched counts before/after.
- Inspect every newly exact alias match; the expected increase should be
  explainable entirely by curated identityAliases or manufacturer groups.
- Confirm no ordinary searchTerm became exact.
- Import a project containing A40-031 and verify the schematic uses the
  existing MeetingBar A40 template.
- Create a temporary ambiguous fixture and verify the UI can select either
  candidate explicitly.


## Acceptance criteria

- A40-031, A50-031, MXW1/O, and WP225/W resolve only through explicit
  identityAliases.
- Bose / DM5C resolves through the reviewed manufacturer equivalence.
- Unique hits become already_in_library.
- All collisions become possible_match and never auto-select index zero.
- The UI records the exact candidate chosen by the user.
- searchTerms remain discovery-only.
- QM75C does not exact-match QM55C.
- Quote inspection remains read-only.
- Project gap analysis uses the same resolver and reports consistent results.
- Existing tests, typecheck/build, and library audit pass.


## Estimate

- Shared type/resolver and tests: 0.5-1 day
- Quote and gap integration: 0.5-1 day
- Ambiguous UI selection: 0.5 day
- Curated data and staging verification: 0.5 day

Expected MVP: approximately 2 days, including verification.
