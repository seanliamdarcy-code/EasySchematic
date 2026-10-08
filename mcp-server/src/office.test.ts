import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { accessVerifier, createOfficeService } from "./office.js";

test("office bridge isolates staff accounts, rejects spoofed origins and keeps MCP calls bound to the authenticated account", async () => {
  const origin = "https://testschematic.tateside.online";
  const office = createOfficeService(async req => {
    const email = req.headers["cf-access-jwt-assertion"];
    if (!['alice@fixture.test', 'bob@fixture.test'].includes(String(email))) throw new Error("Not signed in.");
    return { email: String(email), expires: Date.now() + 60000 };
  }, [origin]);
  office.server.listen(0, "127.0.0.1"); await once(office.server, "listening");
  const address = office.server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const opened: WebSocket[] = [];
  const clients: Client[] = [];
  const connect = async (email: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/editor', { origin, headers: { 'cf-access-jwt-assertion': email } });
    opened.push(socket); await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }));
    assert.equal(JSON.parse(String((await hello)[0])).ok, true);
    return socket;
  };
  try {
    assert.equal((await fetch(base + '/mcp', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/pair?origin=' + encodeURIComponent('https://evil.test'), { headers: { 'cf-access-jwt-assertion': 'alice@fixture.test' } })).status, 403);
    const attacker = new WebSocket(base.replace('http:', 'ws:') + '/editor', { origin: 'https://evil.test', headers: { 'cf-access-jwt-assertion': 'alice@fixture.test' } });
    opened.push(attacker); await assert.rejects(once(attacker, 'open'), /401/);
    const alice = await connect('alice@fixture.test'); const bob = await connect('bob@fixture.test');
    const command = once(alice, 'message'); const result = office.call('alice@fixture.test', 'get_schematic', {});
    const message = JSON.parse(String((await command)[0]));
    bob.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: 'wrong account' }));
    alice.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: 'alice canvas' }));
    assert.equal(await result, 'alice canvas');
    bob.on('message', data => { const msg = JSON.parse(String(data)); if (msg.type === 'command') bob.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: true, result: { account: 'bob' } })); });
    const client = new Client({ name: 'office-fixture', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'cf-access-jwt-assertion': 'bob@fixture.test' } } }));
    assert.equal((await client.listTools()).tools.length, 34);
    const toolResult = await client.callTool({ name: 'get_schematic', arguments: {} });
    assert.match(JSON.stringify(toolResult), /bob/);
    const waiting = office.call('alice@fixture.test', 'get_schematic', {});
    const rejected = assert.rejects(waiting, /Another tab/);
    const newAlice = await connect('alice@fixture.test'); await rejected;
    assert.deepEqual(await office.call('bob@fixture.test', 'get_schematic', {}), { account: 'bob' });
    const disconnected = assert.rejects(office.call('alice@fixture.test', 'get_schematic', {}), /disconnected/);
    newAlice.close(); await disconnected;
    await assert.rejects(office.call('nobody@fixture.test', 'get_schematic', {}), /office account/);
  } finally { for (const client of clients) await client.close(); for (const socket of opened) socket.terminate(); office.close(); }
});

test("office verifier requires a signed, unexpired staff JWT for the configured issuer and audience", async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'fixture-key';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } }));
  const verify = accessVerifier(new URL('https://fixture.cloudflareaccess.com'), 'office-audience');
  const token = async (audience = 'office-audience', expiry = '1h', email: string | undefined = 'Alice@fixture.test') => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setSubject('fixture-staff').setIssuer('https://fixture.cloudflareaccess.com').setAudience(audience).setExpirationTime(expiry).sign(privateKey);
  const request = (assertion?: string) => ({ headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {} }) as Parameters<typeof verify>[0];
  assert.equal((await verify(request(await token()))).email, 'alice@fixture.test');
  await assert.rejects(verify(request()));
  await assert.rejects(verify(request('not-a-jwt')));
  await assert.rejects(verify(request(await token('other-audience'))));
  await assert.rejects(verify(request(await token('office-audience', '-1h'))));
  await assert.rejects(verify(request(await token('office-audience', '1h', ''))));
});
