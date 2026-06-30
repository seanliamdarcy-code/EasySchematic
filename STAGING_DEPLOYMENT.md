# EasySchematic Staging Deployment

This repository has a separate staging lane for testing EasySchematic changes in a live VPS environment before promoting them to the production site.

## Environments

| Environment | Branch | Hostname | VPS path | Compose project | API port | Frontend port |
| --- | --- | --- | --- | --- | --- | --- |
| Production | `master` | `schematic.tateside.online` | `/home/debian/EasySchematic` | `easyschematic` | `8788` | `127.0.0.1:8080` |
| Staging | `staging` | `testschematic.tateside.online` | `/home/debian/EasySchematic-staging` | `easyschematic-staging` | `8789` | `127.0.0.1:8081` |

## Branch flow

Use this promotion path:

```text
feature branch -> staging -> testschematic.tateside.online -> master -> schematic.tateside.online
```

Recommended workflow:

1. Develop changes on a feature branch.
2. Merge or cherry-pick approved work into `staging`.
3. Deploy `staging` to `/home/debian/EasySchematic-staging`.
4. Test at `testschematic.tateside.online`.
5. Merge the tested staging changes into `master`.
6. Deploy `master` to `/home/debian/EasySchematic`.

## Staging API isolation

Production frontend container proxies `/api/tateside/*` (via internal nginx) to host gateway `172.17.0.1:8788`.

Staging frontend container proxies `/api/tateside/*` to host gateway `172.17.0.1:8789`.

Caddy proxies the public staging hostname directly to the staging frontend container (port 8081). Do not edit Caddy configuration.

## AI provider and OpenRouter guardrails

- **Current staging experiment:** OpenRouter is used only by the separate staging API on port `8789`, reached through `testschematic.tateside.online`.
- **Production isolation:** Production API port `8788` and `schematic.tateside.online` remain untouched. Do not reconfigure production provider settings while testing OpenRouter.
- **Single integration point:** Provider integration is centralised in `tateside-api/src/aiProvider.ts`, replacing the former `tateside-api/src/openaiResponses.ts` wrapper. Do not spread provider-specific request code across routes, import flows, or UI components.
- **Model testing:** The Import Devices dialog reads `/api/tateside/ai/settings` and lets users choose research and stronger-retry models per run.
- **Legacy PDF path:** Quote PDF extraction is intentionally unavailable through the current OpenRouter adapter. Use JetBuilt project import, then research missing devices through OpenRouter until a provider-compatible file/PDF path is implemented.
- **Secrets:** Never commit provider keys, tokens, or environment files. Put any staging-only credentials in the intended untracked staging systemd override/EnvironmentFile.
- **Validation required:** Before deploying or promoting provider changes, validate actual structured-output and web-search behaviour with the selected OpenRouter models. Do not rely only on the OpenRouter model list.
- **Operational prerequisite:** Read this document before VPS/API/provider work. Do not deploy or alter VPS configuration as part of a documentation-only change.

## Staging deploy (API + frontend)

Run these commands on the VPS as `debian`. All steps are manual. The staging checkout must be updated and the API build must complete before the first `enable --now`.

1. Update the staging checkout:
   ```bash
   cd /home/debian/EasySchematic-staging
   git fetch origin
   git checkout staging
   git pull --ff-only origin staging
   ```

2. Install the committed staging unit file (sets `TATESIDE_DISABLE_SHAREPOINT=1` and other isolation envs):
   ```bash
   sudo install -m 0644 tateside-api/deploy/tateside-schematic-api-staging.service /etc/systemd/system/tateside-schematic-api-staging.service
   ```

3. Create data dir with correct ownership:
   ```bash
   sudo mkdir -p /var/lib/tateside-schematic-staging
   sudo chown debian:debian /var/lib/tateside-schematic-staging
   ```

4. (Optional) Create a staging-only systemd override or EnvironmentFile (never commit secrets):
   - May contain only `OPENROUTER_API_KEY`, OpenRouter model/default vars, `JETBUILT_API_KEY`, and related non-SharePoint vars when intentionally testing those features.
   - Must contain **no** SharePoint variables (`MS_ENTRA_*`, `TATESIDE_SHAREPOINT_*`, etc.) — SharePoint is hard-disabled by the unit file.
   - Example template: `tateside-api/deploy/tateside-schematic-api-staging.env.example`
   - Load via a drop-in at `/etc/systemd/system/tateside-schematic-api-staging.service.d/override.conf` (or EnvironmentFile).

5. Install deps and build the API (required before first enable/start on fresh checkout):
   ```bash
   npm ci
   npm run tateside:api:build
   ```

6. Reload and enable/start the staging API:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now tateside-schematic-api-staging
   sudo systemctl status tateside-schematic-api-staging --no-pager
   ```

7. Stop staging API before library sync (prevents DB lock):
   ```bash
   sudo systemctl stop tateside-schematic-api-staging
   ```

8. Run the one-way library sync (production DB is source):
   ```bash
   npm run tateside:library:sync-staging -- --source /var/lib/tateside-schematic/tateside.db --destination /var/lib/tateside-schematic-staging/tateside.db
   ```

9. Start/restart staging API:
   ```bash
   sudo systemctl start tateside-schematic-api-staging
   # or restart after any change
   ```

10. Rebuild/restart staging frontend:
    ```bash
    docker compose -p easyschematic-staging -f compose.staging.yml up -d --build
    docker compose -p easyschematic-staging -f compose.staging.yml ps
    ```

11. Validate:
    ```bash
    curl -i http://172.17.0.1:8789/health
    curl -i http://172.17.0.1:8789/api/tateside/devices/templates -H "Cf-Access-Authenticated-User-Email: smoke@test.tateside.com"
    curl -I http://127.0.0.1:8081
    # Public: https://testschematic.tateside.online
    ```

12. Verify isolation: confirm no staging component references port 8788 (check compose env, running containers, and unit file).

## Production deploy

Run these commands on the VPS only when changes have passed staging:

```bash
cd /home/debian/EasySchematic
git fetch origin
git checkout master
git pull --ff-only origin master
docker compose -p easyschematic -f compose.yml up -d --build
curl -I http://127.0.0.1:8080
```

## Architecture and safety (staging isolation)

- **Isolated components**: separate SQLite DB (`tateside.db`), schematic repository dir, JetBuilt index, quote-research cache (`quote-research-cache.json`), dedicated API process, dedicated API port (8789), and container.
- Device library in staging is a deliberate one-way snapshot copy of production's active (non-deleted) device records + all of their versions (with each device's current_version_id relationship preserved).
- No SharePoint integration is possible in staging (hard-disabled by `TATESIDE_DISABLE_SHAREPOINT=1` in the staging unit; `getConfig()` always returns `sharePoint: null` regardless of any SharePoint/Microsoft Graph variables; endpoints 503). The staging unit file sets the flag. Never set SharePoint env vars on staging.
- Staging writes (new library edits, new schematics, research cache) remain local to staging DB/repo and are overwritten or removed on the next deliberate library refresh.
- Refresh is strictly one-way: production DB -> staging DB. Never run sync in reverse.
- Deployment and refreshes are manual operator steps. No automation (e.g. GitHub Actions) performs staging deploys or syncs.
- Always stop the staging API before a library sync. Use the dedicated npm script for sync.
- Verify after changes: no staging path, env, or unit references production's 8788/paths.
- Production behaviour is unchanged: prod continues to use 8788 + prod paths exclusively.

## Port and path expectations

- Production: API `172.17.0.1:8788`, frontend container `127.0.0.1:8080`
- Staging: API `172.17.0.1:8789`, frontend container `127.0.0.1:8081`

## Separate checkouts

Do not run staging Compose commands inside `/home/debian/EasySchematic`.

Do not run production Compose commands inside `/home/debian/EasySchematic-staging`.

Keep staging and production as separate checkouts, separate Compose projects, and separate localhost ports.
