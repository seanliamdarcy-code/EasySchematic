import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "./http-app.js";

test("Grok HTTP connector requires consent, PKCE and bearer auth before exposing existing tools", async t => {
  const origin = "https://connector.example.test";
  const pairingToken = "test-only-pairing-token-at-least-32-characters";
  const calls: string[] = [];
  const { app, auth } = createHttpApp(new URL(origin), pairingToken, async name => { calls.push(name); return { fixture: true }; });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
  const consent = (request: string, token: string, extra: Record<string, string> = {}) => fetch(base + "/consent", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...extra },
    body: new URLSearchParams({ request, token, decision: "allow" }), redirect: "manual",
  });
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "https://grok.com/oauth/callback";
  let client: Client | undefined;
  try {
    assert.equal((await post("/mcp", {})).status, 401);
    const metadata = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json() as { resource: string };
    assert.equal(metadata.resource, origin + "/mcp");
    assert.equal((await post("/register", { redirect_uris: ["https://attacker.test/callback"], token_endpoint_auth_method: "none" })).status, 400);
    const registration = await post("/register", { redirect_uris: [redirect], client_name: "Grok", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as { client_id: string };
    const query = new URLSearchParams({ client_id: registered.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "schematic", state: "fixture-state", resource: origin + "/mcp" });
    const authorizationPage = await fetch(base + "/authorize?" + query);
    assert(authorizationPage.headers.get("content-security-policy")?.includes("form-action 'self' https://grok.com;"));
    const page = await authorizationPage.text();
    assert(!page.includes(pairingToken));
    const request = /name="request" value="([a-f0-9]+)"/.exec(page)?.[1];
    assert(request);
    assert.equal((await consent(request, pairingToken, { Origin: "https://attacker.test" })).status, 403);
    assert.equal((await consent(request, "wrong-token")).status, 400);
    const approved = await consent(request, pairingToken);
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get("location")!);
    assert.equal(callback.searchParams.get("state"), "fixture-state");
    const code = callback.searchParams.get("code")!;
    const exchange = (codeVerifier: string) => fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: codeVerifier, redirect_uri: redirect, resource: origin + "/mcp" }) });
    assert.equal((await exchange("x".repeat(64))).status, 400);
    const tokenResponse = await exchange(verifier);
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    assert.equal((await exchange(verifier)).status, 400);
    assert.equal((await consent(request, pairingToken)).status, 400);
    assert.equal((await auth.verifyAccessToken(tokens.access_token)).resource?.href, origin + "/mcp");
    client = new Client({ name: "grok-http-fixture", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 45);
    assert(tools.tools.some(tool => tool.name === "start_jetbuilt_schematic"));
    await client.callTool({ name: "get_schematic", arguments: {} });
    assert.deepEqual(calls, ["get_schematic"]);
    const fullClient = auth.clientsStore.getClient(registered.client_id)!;
    await assert.rejects(auth.exchangeRefreshToken(fullClient, tokens.refresh_token, ["admin"]));
    const refreshed = await auth.exchangeRefreshToken(fullClient, tokens.refresh_token);
    await assert.rejects(auth.exchangeRefreshToken(fullClient, tokens.refresh_token));
    await auth.revokeToken(fullClient, { token: refreshed.access_token });
    await assert.rejects(auth.verifyAccessToken(refreshed.access_token));
    let clock = Date.now() + 86_370_000;
    t.mock.method(Date, "now", () => clock);
    const nearExpiry = await auth.exchangeRefreshToken(fullClient, refreshed.refresh_token!);
    assert(nearExpiry.expires_in! > 0 && nearExpiry.expires_in! <= 30);
    clock += 60_000;
    await assert.rejects(auth.verifyAccessToken(nearExpiry.access_token));
    await assert.rejects(auth.exchangeRefreshToken(fullClient, nearExpiry.refresh_token!));
    t.mock.restoreAll();
  } finally {
    await client?.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});

test("Grok connector rejects unsafe public origins", () => {
  for (const url of ["http://example.test", "https://example.test/path", "https://user:pass@example.test", "https://example.test/?secret=value"]) {
    assert.throws(() => createHttpApp(new URL(url), "fixture", async () => ({})));
  }
});
