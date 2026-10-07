# TateSide staging release

The current staging integration candidate is `codex/staging-reconciliation`.
The old `staging` branch remains an experiment/reference; it does not identify the deployed release.

| Environment | Checkout | Frontend | API | Data |
|---|---|---|---|---|
| Test | `/home/debian/EasySchematic-staging` | `127.0.0.1:8081` | `172.17.0.1:8789` | `/var/lib/tateside-schematic-staging` |
| Production | `/home/debian/EasySchematic` | `127.0.0.1:8080` | `172.17.0.1:8788` | `/var/lib/tateside-schematic` |

Public test URL: https://testschematic.tateside.online.
Production URL: https://schematic.tateside.online.
Both use Cloudflare Access. Staging SharePoint is disabled; do not connect it to production SharePoint for testing.
Existing private provider/MCP overrides stay on the VPS. This release preserves the current OpenAI research path; the alternative OpenRouter UI/provider experiment and latest-project browser remain on the older branch.

## Before deployment

1. Commit and push the candidate. Record its full SHA.
2. Save laptop changes separately. Back up both environments with SQLite's backup API, not a copy of a live WAL database file. Archive their schematic repositories and the staging source/configuration/runtime. Keep a verified off-VPS copy.
3. Inspect the VPS branch, dirty files, and services. Preserve unknown edits and operational scripts.
4. Fetch the candidate. Compare loose staging files with the target tree before reconciling them. An identical file can be incorporated into Git after it has been backed up; do not discard different content.

## Verification before deployment

Use Node 24 and the committed lockfile:

```sh
npm ci
npm run lint
npm test
npm run tateside:api:build
node --test 'tateside-api/*.local.test.mjs'
npm run build
npx playwright install chromium
npx playwright test
npm audit --omit=dev
```

Browser tests use an isolated local database and mocked Jetbuilt responses. They do not spend AI credits or write to the live library. Human testing is still needed for authenticated staff workflows and provider behaviour. Development/build dependency advisories must be assessed separately from the runtime audit.

## Deploy staging only

After the checkout is reconciled and clean:

```sh
cd /home/debian/EasySchematic-staging
test "$(git branch --show-current)" = codex/staging-reconciliation
test -z "$(git status --porcelain --untracked-files=no)"
npm ci
npm run tateside:api:build
export EASYSCHEMATIC_BUILD_HASH=$(git rev-parse HEAD)
docker compose -f compose.staging.yml build
sudo install -m 0644 tateside-api/deploy/staging-release.conf /etc/systemd/system/tateside-schematic-api-staging.service.d/release.conf
sudo systemctl daemon-reload
sudo systemctl restart tateside-schematic-api-staging.service
docker compose -f compose.staging.yml up -d --no-build
```

The tracked Compose file replaces the previously loose staging file. Its port mapping remains 8081. Docker receives the source SHA explicitly so build-info works without including `.git` or private data in the build context.

Require the API `/health` build hash and frontend `/build-info.json` hash to match the checkout. Check services, authenticated read routes, library/schematic counts, and production's unchanged build ID. Confirm that public unauthenticated access still redirects to Cloudflare Access.

## Review and promotion

Test project/room import, bundles, possible-match selection, non-hardware filtering, library editing, Library Doctor, and save/open/autosave. Test SharePoint separately in a suitable environment: staging deliberately disables it. AI/provider calls have not been live-tested by fixture-based checks.

Select the tested commit for production only after user acceptance. Code and library data are separate releases: do not replace production SQLite with staging SQLite. Prepare a previewable identity-aware merge that preserves production-only devices, schematics, and version history.

GitHub's inherited `deploy-prod.yml` and `backup-d1.yml` target Cloudflare Workers/D1, not this VPS. GitHub pushes do not deploy either TateSide environment.

## Rollback

Keep the previous image ID, compiled backend, Git SHA/patch, service configuration, and database backups together. Restore the previous staging code/runtime and image/configuration if verification fails. Restart staging only. Restore its database only if required and account for any intervening staging edits. Do not roll back or restart production as part of staging work.
