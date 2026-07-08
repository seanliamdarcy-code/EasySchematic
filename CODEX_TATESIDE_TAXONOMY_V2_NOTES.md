# TateSide Taxonomy V2 Notes

Phase 1 Library Audit should stay classification-neutral. The audit can show
where the current model is awkward, but it should not treat manufacturer/model
heuristics as truth until the taxonomy is redesigned.

## Direction

- `category` should be a UI grouping, not semantic proof.
- `deviceType` should be the primary object type.
- Future fields should split flexible meaning into `roleTags`, `capabilities`,
  and `protocols`.
- `connectorType` should remain the physical connector only.
- `signalType` should describe a signal family, but should not carry every
  protocol nuance alone.
- RJ45 can mean Ethernet, Dante, AVB, AES67, AmpLink, Q-LAN, HDBaseT, control,
  or other transport-specific meanings.
- `brandConventions` plus evidence/review metadata are needed before
  MCP-assisted corrections are safe.
- Taxonomy changes should happen before any Library Doctor write/apply workflow.

## Before Write Workflows

Future Library Doctor work should expose canonical values, deprecated aliases,
current template state, proposed changes, evidence, preview diffs, human
approval, and audit history before any apply path exists.
