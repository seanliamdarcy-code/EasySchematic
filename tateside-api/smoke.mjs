const apiBaseUrl = new URL(process.env.TATESIDE_API_SMOKE_URL || "http://127.0.0.1:8788");
const origin = process.env.TATESIDE_API_SMOKE_ORIGIN || "http://localhost:5173";
const accessEmail = process.env.TATESIDE_API_SMOKE_ACCESS_EMAIL;

function requestHeaders() {
  return {
    Origin: origin,
    ...(accessEmail ? { "Cf-Access-Authenticated-User-Email": accessEmail } : {}),
  };
}

async function readJson(url) {
  const response = await fetch(url, {
    headers: requestHeaders(),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url.pathname} returned ${response.status}: ${body || response.statusText}`);
  }

  return {
    response,
    body: body ? JSON.parse(body) : null,
  };
}

function assertLocalCors(response) {
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  if (allowedOrigin !== origin) {
    throw new Error(`Expected Access-Control-Allow-Origin ${origin}; received ${allowedOrigin ?? "none"}`);
  }
}

async function main() {
  const healthUrl = new URL("/health", apiBaseUrl);
  const templatesUrl = new URL("/api/tateside/devices/templates", apiBaseUrl);

  const health = await readJson(healthUrl);
  if (health.body?.ok !== true || health.body?.service !== "tateside-api") {
    throw new Error(`/health returned an unexpected payload: ${JSON.stringify(health.body)}`);
  }
  assertLocalCors(health.response);

  const templates = await readJson(templatesUrl);
  if (!Array.isArray(templates.body)) {
    throw new Error(`/api/tateside/devices/templates did not return an array: ${JSON.stringify(templates.body)}`);
  }
  assertLocalCors(templates.response);

  console.log(`TateSide API smoke passed: health and device-template list responded from ${apiBaseUrl.origin}.`);
}

main().catch((error) => {
  console.error(`TateSide API smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
