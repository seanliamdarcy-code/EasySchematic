# EasySchematic Agent Instructions

Read this file before making repository, VPS, API, deployment, or AI-provider changes. For VPS/API work, also read `STAGING_DEPLOYMENT.md` first.

## Environment facts

| Environment | Branch | Hostname | API | Notes |
| --- | --- | --- | --- | --- |
| Production | `master` | `schematic.tateside.online` | `8788` | Production configuration and data. |
| Staging | `staging` | `testschematic.tateside.online` | `8789` | Dedicated staging API and isolated staging data. |

Staging is isolated from production for its SQLite DB, schematic repository, JetBuilt index, and quote-research cache. Do not route staging back to production API port `8788` or production data paths.

SharePoint is hard-disabled in staging. Do not add SharePoint/Microsoft Graph environment variables, do not test staging writes against production SharePoint, and do not weaken `TATESIDE_DISABLE_SHAREPOINT=1` behaviour.

## AI provider rules

AI provider integration is centralised in `tateside-api/src/aiProvider.ts`, replacing the former `tateside-api/src/openaiResponses.ts` wrapper. Do not scatter provider-specific request logic across routes, import flows, or UI components.

The current provider experiment uses OpenRouter only in staging: the separate staging API on port `8789` behind `testschematic.tateside.online`. Production remains on its existing configuration and must not be reconfigured as part of OpenRouter testing.

Quote PDF extraction is intentionally unavailable through the current OpenRouter adapter. Direct users to JetBuilt project import until a provider-compatible file/PDF path has been designed, implemented, and validated.

OpenRouter credentials belong only in untracked server environment files or systemd overrides. Never commit keys, tokens, secrets, or environment files, and never alter the production API on port `8788` while testing staging provider changes.

Before any deploy or promotion, validate actual structured-output and web-search behaviour with the selected OpenRouter models. Do not assume a model is compatible just because it appears in the OpenRouter model list.

## Operational guardrails

- Inspect `git status` before edits and before commits.
- Do not discard, reset, stash, amend, or overwrite uncommitted work unless explicitly asked.
- Keep staging and production branches, checkouts, ports, and data paths separate.
- Documentation-only tasks should not run deploy commands or modify VPS state.
- Read `STAGING_DEPLOYMENT.md` before VPS/API work, including staging API, systemd, Docker, Caddy, provider, SharePoint, JetBuilt, or data-sync changes.
