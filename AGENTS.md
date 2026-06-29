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

The active AI provider is OpenAI.

OpenRouter is only a planned staging-only experiment. It is not active yet and must not be treated as a drop-in production provider.

Provider work must stay centralised in `tateside-api/src/openaiResponses.ts` unless a deliberate provider adapter abstraction is added there. Do not scatter provider-specific request logic elsewhere.

Do not use a base-URL/key swap shortcut for OpenRouter. File uploads, web-search tools, source extraction, structured output, and error handling need a real provider adapter before any trial.

Never commit keys, tokens, secrets, or environment files. Never alter production configuration while testing OpenRouter or any staging-only provider experiment.

## Operational guardrails

- Inspect `git status` before edits and before commits.
- Do not discard, reset, stash, amend, or overwrite uncommitted work unless explicitly asked.
- Keep staging and production branches, checkouts, ports, and data paths separate.
- Documentation-only tasks should not run deploy commands or modify VPS state.
- Read `STAGING_DEPLOYMENT.md` before VPS/API work, including staging API, systemd, Docker, Caddy, provider, SharePoint, JetBuilt, or data-sync changes.
