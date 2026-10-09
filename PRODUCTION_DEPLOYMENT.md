# TateSide production release

The production editor is `https://schematic.tateside.online`. It runs on the VPS,
not the inherited Cloudflare Workers/D1 deployment workflows. Git pushes run CI;
they do not activate TateSide production. Read `STAGING_DEPLOYMENT.md` for test.

## Release preparation

Use a clean committed Node 24 checkout and `npm ci`. Run lint, application tests,
API build/tests, MCP build/tests and isolated Playwright tests as specified in
`AGENTS.md`. Clear inherited Microsoft, Jetbuilt, OpenAI and live-site overrides
before fixture tests. Test SharePoint uses real shared Projects storage.

Build production frontend with `VITE_BUILD_HASH` set to the full release SHA and
`VITE_EASYSCHEMATIC_OFFICE_ORIGIN=https://schematic-mcp-production.tateside.online`.
The default remains the existing test connector. Normal `compose.yml` supplies
both build arguments. For constrained VPS disk space, build on the workstation,
archive `dist/`, `docker/nginx.conf` and `docker/Dockerfile.prebuilt`, checksum the
artifact, and build the small runtime image with that Dockerfile on the VPS.
Retain previous hashed assets alongside the new assets until old clients reload.
Do not overwrite new assets with older files.

Prepare the API and MCP under `/home/debian/easyschematic-releases/<full-sha>`.
Check out exactly that commit, install from both lockfiles, and build there.
The API build requires Git metadata to record its SHA. Do not run either API
against production storage during preparation. Keep release directories immutable
after activation. Record source SHA, frontend artifact SHA and Docker image digest.

Render `tateside-api/deploy/production-release.conf.in` with this absolute path.
It overrides the old API executable while preserving private environment files
and provider settings. Production data stays at `/var/lib/tateside-schematic`,
frontend at loopback 8080 and API at Docker bridge 172.17.0.1:8788.

## Office connector isolation

Use `office-production.service.in`, rendered to the same pinned release, as
`easyschematic-office-production.service`. Its protected environment file supplies:

```text
EASYSCHEMATIC_ACCESS_ISSUER=https://tateside.cloudflareaccess.com
EASYSCHEMATIC_ACCESS_AUDIENCE=<production-connector-Access-audience>
EASYSCHEMATIC_OFFICE_EDITOR_ORIGINS=https://schematic.tateside.online
EASYSCHEMATIC_OFFICE_PORT=8793
EASYSCHEMATIC_BUILD_HASH=<full-release-sha>
```

Route the exact production connector hostname through Cloudflare Tunnel to
loopback 8793 with Access JWT validation required and its exact audience. Restrict
Access to `tateside.com` staff using production's Microsoft Entra provider.
Preserve existing office OAuth callback restrictions. The test connector on 8792
and its test-only origin remain independent. Never add both editor origins to one
office process: it supports one editor per email. For optional laptop pairing,
explicitly add the production origin to `EASYSCHEMATIC_MCP_ORIGINS` on that laptop;
do not widen the allowlist to arbitrary origins or share pairing tokens.

## Data promotion and cutover

Code deployment and library promotion are separate. Never replace production
SQLite with test SQLite. Use a reviewed manifest that retains active production
IDs, preserves production-only Devices, appends Device versions/audit events and
records staging provenance. Resolve deleted and changed identities before apply.
Do not promote test schematics, test proposals or test audit history. Seeded
taxonomy and bundles must be compared semantically; preserve destination IDs.

1. Verify original-runtime restore, upgraded-runtime rehearsal and forward/inverse
   library merge on isolated copies without provider credentials.
2. Agree a quiet window and have staff save/export browser-only work. Prebuild
   everything. Gate production editor/API/connector writes, drain and stop writers.
3. Take paired SQLite/repository snapshots while writers are stopped. Preserve
   source, compiled runtime/dependencies, image, systemd overrides and private
   configuration. Protect credentials, verify checksums and an off-VPS copy.
4. Apply rehearsed migrations and a transaction guarded by exact library baseline
   hashes. Abort if the library has changed. Existing schematic/history hashes
   must be preserved. Validate integrity, foreign keys and expected counts.
5. Install the rendered API drop-in, reload systemd and start the new API. Activate
   only the production frontend container with the pinned image and API port 8788.
   Verify frontend and API build hashes and paths before reopening writes.
6. Check signed-in/signed-out access, direct-origin denial, existing open/save and
   restore, library/history, Jetbuilt import, taxonomy, Library Doctor, print/PDF,
   SharePoint and AI pairing. Use uniquely named acceptance artifacts. Never
   permanently remove unrelated files. Record any unverified provider workflow.

Cloudflare Tunnel is the authenticated entrypoint. Direct public origin requests
for both editors must remain denied by Caddy. Never restore the old vulnerable
origin route as part of rollback. Leave unrelated VPS services untouched.

## Rollback and ongoing operations

Before reopening writes, restore the final paired database/repository and old
runtime/image if checks fail; stop all writers first and retain failed state.
After reopening, freeze and snapshot current state before recovery. Never replace
new user edits with an old backup. Prefer a forward repair or guarded selective
inverse that preserves version history; consult the owner before data loss.

Retain rollback artifacts for at least seven days, subject to capacity. Establish
scheduled consistent backups with a verified off-VPS destination, failure
notification and restore drill. Record retention and recovery targets. Watch API
errors/save failures, restart counts and disk growth through the next working day.
Do not prune Docker volumes or unrelated images to make room.
