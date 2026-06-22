# TateSide API

Small VPS-hosted API for TateSide-owned EasySchematic data.

## Device Library

Implemented endpoints:

```text
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

Use Ctrl+C in the `dev:full` terminal to stop its API compiler, API server, and Vite process together.

## Environment

```text
TATESIDE_DATA_DIR=/var/lib/tateside-schematic
TATESIDE_DB_PATH=/var/lib/tateside-schematic/tateside.db
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

SharePoint endpoints are intentionally stubbed for now. The device database lives in this VPS API; SharePoint will be used for schematic JSON and generated exports.
