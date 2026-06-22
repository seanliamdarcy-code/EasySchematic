# TateSide API

Small VPS-hosted API for TateSide-owned EasySchematic data.

## Device Library

Implemented endpoints:

```text
GET  /api/tateside/schematics
POST /api/tateside/schematics
GET  /api/tateside/schematics/:id
PUT  /api/tateside/schematics/:id
GET  /api/tateside/schematics/:id/versions
GET  /api/tateside/schematics/:id/versions/:sequence
POST /api/tateside/schematics/:id/restore
GET  /api/tateside/devices/templates
POST /api/tateside/devices/templates
POST /api/tateside/quote-import/extract
POST /api/tateside/quote-import/research
GET  /health
```

The device database uses SQLite with file-based migrations in `tateside-api/migrations`.

Default data path:

```text
/var/lib/tateside-schematic/tateside.db
```

Local Windows fallback:

```text
.tateside-data/tateside.db
```

## Commands

```bash
npm run tateside:api:build
npm run tateside:api
npm run tateside:api:test:routes
```

`npm run tateside:api` compiles the TypeScript service and then starts:

```bash
node dist-tateside-api/tateside-api/src/server.js
```

## Local full-stack development

Start the local TateSide API and Vite frontend together:

```bash
npm run dev:full
```

This first compiles the API, then keeps the API TypeScript compiler and Node server in watch mode. Once `http://127.0.0.1:8788/health` is ready, it starts Vite. During this command only, Vite proxies browser requests from `/api/tateside/*` to the local API. Plain `npm run dev` is unchanged and does not enable that proxy.

The local API uses `.tateside-data/tateside.db` by default on Windows. It is ignored by Git and is separate from production data.

In another terminal, smoke-test a running local API without modifying data:

```bash
npm run tateside:api:smoke
```

The smoke check verifies `/health`, the device-template listing endpoint, and the local browser CORS response. It targets `http://127.0.0.1:8788` by default. For a non-default local endpoint, set `TATESIDE_API_SMOKE_URL`; set `TATESIDE_API_SMOKE_ACCESS_EMAIL` only when testing with access-identity enforcement enabled.

Run the local schematic route integration test with:

```bash
npm run tateside:api:test:routes
```

That command compiles the API, starts the compiled server on an isolated temp data directory and ephemeral localhost port, exercises the full schematic route contract, and shuts the server down automatically. It does not require Cloudflare, Microsoft, or any credentials.

Use Ctrl+C in the `dev:full` terminal to stop its API compiler, API server, and Vite process together.

## Schematic Repository API

All schematic routes require the resolved Cloudflare Access identity when `TATESIDE_REQUIRE_ACCESS_IDENTITY=1`; the API passes that actor email into schematic storage and audit logging.

Routes:

```text
GET  /api/tateside/schematics
POST /api/tateside/schematics
GET  /api/tateside/schematics/:id
PUT  /api/tateside/schematics/:id
GET  /api/tateside/schematics/:id/versions
GET  /api/tateside/schematics/:id/versions/:sequence
POST /api/tateside/schematics/:id/restore
```

Contract:

```text
GET /api/tateside/schematics
  -> 200 with an array of recent schematic summaries

POST /api/tateside/schematics
  body: { data, source? }
  -> 201 with the current schematic document for the new server-assigned id

GET /api/tateside/schematics/:id
  -> 200 with the current schematic document

PUT /api/tateside/schematics/:id
  body: { data, source? }
  -> 200 with the current schematic document plus createdNewVersion

GET /api/tateside/schematics/:id/versions
  -> 200 with { schematic, versions }

GET /api/tateside/schematics/:id/versions/:sequence
  -> 200 with that version document

POST /api/tateside/schematics/:id/restore
  body: { sequence, source? }
  -> 200 with the restored current schematic document
```

Validation and limits:

```text
- Schematic request bodies must be JSON objects.
- :sequence must be a positive safe integer.
- Schematic JSON payloads use TATESIDE_SCHEMATIC_MAX_JSON_BYTES.
- Non-schematic JSON routes continue to use the generic 2 MiB request-body limit.
- SchematicStoreError responses return their configured HTTP status with { "error": "..." }.
```

## Environment

```text
TATESIDE_DATA_DIR=/var/lib/tateside-schematic
TATESIDE_DB_PATH=/var/lib/tateside-schematic/tateside.db
TATESIDE_SCHEMATIC_REPOSITORY_PATH=/var/lib/tateside-schematic/schematic-repository
TATESIDE_SCHEMATIC_MAX_JSON_BYTES=10485760
TATESIDE_API_HOST=127.0.0.1
TATESIDE_API_PORT=8788
TATESIDE_ALLOWED_ORIGIN=https://schematic.tateside.online
TATESIDE_REQUIRE_ACCESS_IDENTITY=1
OPENAI_API_KEY=<required for AI quote import>
OPENAI_QUOTE_EXTRACTION_MODEL=gpt-5.4-nano
OPENAI_DEVICE_RESEARCH_MODEL=gpt-5.4-mini
OPENAI_DEVICE_ESCALATION_MODEL=gpt-5.4
OPENAI_QUOTE_EXTRACTION_REASONING_EFFORT=low
OPENAI_DEVICE_RESEARCH_REASONING_EFFORT=medium
OPENAI_DEVICE_ESCALATION_REASONING_EFFORT=medium
OPENAI_QUOTE_IMPORT_MAX_FILE_BYTES=15728640
```

If `OPENAI_API_KEY` is missing, the rest of the TateSide app still works normally and only the AI quote-import workflow is unavailable.

`TATESIDE_REQUIRE_ACCESS_IDENTITY=1` requires the Cloudflare Access header:

```text
Cf-Access-Authenticated-User-Email
```

Use this only when the service is behind Cloudflare Access or a trusted reverse proxy that preserves the header.

## VPS Shape

Recommended first deployment:

```text
Cloudflare Tunnel / Nginx
  /api/tateside/* -> http://127.0.0.1:8788/api/tateside/*
  /*              -> existing static EasySchematic app
```

The API should bind to localhost only. Do not expose port `8788` publicly.

## SharePoint

SharePoint routes are now wired locally to the Graph client (SP-3B). When SharePoint config is absent the endpoints return a safe 503 ("SharePoint is not configured on the TateSide API server") and remain unavailable until the server config and Entra site grant are added. No claim is made that Azure/SharePoint is configured in this environment.

Configuration is all-or-nothing:

```text
- If none of the SharePoint environment variables are set, SharePoint is fully disabled.
- If any SharePoint variable is set, all required SharePoint variables must be set or startup fails.
```

Required environment keys:

```text
MS_ENTRA_TENANT_ID
MS_GRAPH_CLIENT_ID
MS_GRAPH_CLIENT_SECRET
TATESIDE_SHAREPOINT_SITE_ID
TATESIDE_SHAREPOINT_DRIVE_ID
TATESIDE_SHAREPOINT_ROOT_FOLDER_ID
```

Local test overrides, only when `NODE_ENV=test`:

```text
MS_ENTRA_BASE_URL
MS_GRAPH_BASE_URL
```

Root containment and hardening:

```text
- Every resolved folder or file must trace back to TATESIDE_SHAREPOINT_ROOT_FOLDER_ID.
- Page tokens must decode to a safe Graph next-link whose origin and children path match the configured Graph base URL.
- Malformed or forged next links are rejected.
- Upload results are re-validated under the configured root before they are returned.
- JSON filenames reject path separators, control characters, SharePoint/Windows reserved characters < > : " | ? *, . and .., and trailing dot/space.
- /content downloads inspect the first Graph response manually and, when redirected to a pre-authorised URL, follow at most one safe http/https redirect without forwarding Authorization.
```

Run the local mocked SharePoint Graph client test with:

```bash
npm run tateside:api:test:sharepoint
```

Run the local route integration test (uses a mocked HTTP identity+Graph service, launches the compiled server, exercises the exact frontend contracts under test-only base overrides) with:

```bash
npm run tateside:api:test:sharepoint-routes
```

The Graph client test uses a deterministic mocked `fetch` implementation, requires no Microsoft credentials, verifies token reuse, configured-root list and nested breadcrumb behavior, root escape rejection, forged page-token rejection, upload request shape and filename validation, download redirect safety, JSON parsing, and safe Graph error mapping.

The routes test covers: root listing contract with folderId:null + root breadcrumb id:null, nested breadcrumb/parentId contract, missing CF identity 401, PUT forwarded to mock returning safe metadata, GET returning raw SchematicFile, contained Graph errors mapped safely to 4xx/5xx, and unconfigured 503.
