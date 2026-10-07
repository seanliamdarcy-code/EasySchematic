# EasySchematic TateSide

Read `STAGING_DEPLOYMENT.md` before VPS, deployment, or data-promotion work.

- The staging integration candidate is `codex/staging-reconciliation`; older `staging` and feature branches are preserved experiments/checkpoints.
- Frontend and TateSide API deploy separately. Confirm both build hashes against the committed release.
- Test services/data use the `-staging` names, ports 8081/8789, and `/var/lib/tateside-schematic-staging`. Production uses 8080/8788 and `/var/lib/tateside-schematic`.
- Preserve private environment/provider overrides. Never print or commit credentials.
- Staging SharePoint uses the normal shared Projects folder at the user's request. Credentials are supplied by the private VPS `sharepoint.conf` drop-in and protected EnvironmentFile; never commit them. Staging saves/publishes are real shared files. Fixture tests must not write there; any live verification file must be uniquely named and removed afterward.
- Code deployment does not promote device-library data. Preserve production schematics, history, and production-only devices when preparing a reviewed data merge.
- Use Node 24, `npm ci`, `npm run lint`, `npm test`, `npm run tateside:api:build`, `node --test 'tateside-api/*.local.test.mjs'`, `npm run build`, and `npx playwright test` for release validation.
- Browser tests use isolated local data and mocked external responses. Never run fixture-based write tests against live staging/production databases.

- Live schematic MCP runs locally (`mcp-server`), paired to the test editor. Build/test it with `npm ci --prefix mcp-server` and `npm test --prefix mcp-server`. Codex uses 8765 and Claude 8766 on Sean's laptop. See `mcp-server/README.md` for pairing and missing-device review/publication. Never log pairing tokens.
