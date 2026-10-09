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
  const logs: string[] = [];
  const office = createOfficeService(async req => {
    const email = req.headers["cf-access-jwt-assertion"];
    if (!['alice@fixture.test', 'bob@fixture.test'].includes(String(email))) throw new Error("Not signed in.");
    return { email: String(email), expires: Date.now() + 60000, subject: `subject-${email}` };
  }, [origin], message => logs.push(message));
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
    const ack = JSON.parse(String((await hello)[0]));
    assert.equal(ack.ok, true);
    assert.equal(ack.officeEmail, email);
    return socket;
  };
  try {
    assert.equal((await fetch(base + '/mcp', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/status')).status, 401);
    const status = (email: string) => fetch(base + '/status', { headers: { 'cf-access-jwt-assertion': email } }).then(response => response.json());
    assert.equal((await status('alice@fixture.test')).condition, 'account_not_linked');
    await assert.rejects(office.call('alice@fixture.test', 'get_schematic', {}), /\[account_not_linked\].*alice@fixture.test.*testschematic/);
    assert.equal((await fetch(base + '/pair?origin=' + encodeURIComponent(origin), { headers: { 'cf-access-jwt-assertion': 'alice@fixture.test' } })).status, 200);
    assert.equal((await status('alice@fixture.test')).condition, 'relay_not_connected');
    assert.equal((await fetch(base + '/pair?origin=' + encodeURIComponent('https://evil.test'), { headers: { 'cf-access-jwt-assertion': 'alice@fixture.test' } })).status, 403);
    const attacker = new WebSocket(base.replace('http:', 'ws:') + '/editor', { origin: 'https://evil.test', headers: { 'cf-access-jwt-assertion': 'alice@fixture.test' } });
    opened.push(attacker); await assert.rejects(once(attacker, 'open'), /401/);
    const alice = await connect('alice@fixture.test'); const bob = await connect('bob@fixture.test');
    assert.equal((await status('alice@fixture.test')).condition, 'connected');
    const command = once(alice, 'message'); const result = office.call('alice@fixture.test', 'get_schematic', {});
    const message = JSON.parse(String((await command)[0]));
    bob.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: 'wrong account' }));
    alice.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, result: 'alice canvas' }));
    assert.equal(await result, 'alice canvas');
    bob.on('message', data => { const msg = JSON.parse(String(data)); if (msg.type === 'command') bob.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: true, result: { account: 'bob' } })); });
    const client = new Client({ name: 'office-fixture', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'cf-access-jwt-assertion': 'bob@fixture.test' } } }));
    assert.equal((await client.listTools()).tools.length, 45);
    const toolResult = await client.callTool({ name: 'get_schematic', arguments: {} });
    assert.match(JSON.stringify(toolResult), /bob/);
    const waiting = office.call('alice@fixture.test', 'get_schematic', {});
    const rejected = assert.rejects(waiting, /Another tab/);
    const newAlice = await connect('alice@fixture.test'); await rejected;
    assert.deepEqual(await office.call('bob@fixture.test', 'get_schematic', {}), { account: 'bob' });
    const disconnected = assert.rejects(office.call('alice@fixture.test', 'get_schematic', {}), /disconnected/);
    const closed = once(newAlice, 'close');
    newAlice.close(); await disconnected; await closed;
    assert.equal((await status('alice@fixture.test')).condition, 'relay_not_connected');
    await assert.rejects(office.call('alice@fixture.test', 'get_schematic', {}), /\[relay_not_connected\]/);
    await assert.rejects(office.call('nobody@fixture.test', 'get_schematic', {}), /office account/);
    const events = logs.map(line => JSON.parse(line));
    assert(events.some(event => event.event === 'office_editor_connected' && event.email === 'bob@fixture.test' && event.subject === 'subject-bob@fixture.test'));
    assert(events.some(event => event.event === 'office_mcp_call' && event.email === 'bob@fixture.test' && event.subject === 'subject-bob@fixture.test' && event.condition === 'connected'));
  } finally { for (const client of clients) await client.close(); for (const socket of opened) socket.terminate(); office.close(); }
});

test("office diagnostics report expiry and never expose another account's editor", async () => {
  const origin = 'https://schematic.tateside.online';
  const office = createOfficeService(async () => ({ email: 'alice@fixture.test', expires: Date.now() + 60000 }), [origin], () => {});
  office.server.listen(0, '127.0.0.1'); await once(office.server, 'listening');
  const address = office.server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/editor', { origin });
  try {
    await once(socket, 'open');
    const hello = once(socket, 'message'); socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1 })); await hello;
    await assert.rejects(office.call('bob@fixture.test', 'get_schematic', {}), error => {
      assert.match(String(error), /\[account_not_linked\].*bob@fixture.test/);
      assert.doesNotMatch(String(error), /alice/);
      return true;
    });
    const actualNow = Date.now();
    const mock = test.mock.method(Date, 'now', () => actualNow + 120000);
    try { await assert.rejects(office.call('alice@fixture.test', 'get_schematic', {}), /expired/); }
    finally { mock.mock.restore(); }
  } finally { socket.terminate(); office.close(); }
});

test("production and test office processes keep the same staff member's editors independent", async () => {
  const origins = ["https://schematic.tateside.online", "https://testschematic.tateside.online"];
  const offices = origins.map(origin => createOfficeService(async () => ({ email: "alice@fixture.test", expires: Date.now() + 60000 }), [origin]));
  const sockets: WebSocket[] = [];
  try {
    for (const [index, office] of offices.entries()) {
      office.server.listen(0, "127.0.0.1"); await once(office.server, "listening");
      const address = office.server.address(); assert(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(base + "/pair?origin=" + encodeURIComponent(origins[1 - index]))).status, 403);
      const socket = new WebSocket(base.replace("http:", "ws:") + "/editor", { origin: origins[index] });
      sockets.push(socket); await once(socket, "open");
      const hello = once(socket, "message"); socket.send(JSON.stringify({ type: "hello", protocolVersion: 1 })); await hello;
      socket.on("message", data => {
        const message = JSON.parse(String(data));
        if (message.type === "command") socket.send(JSON.stringify({ type: "response", requestId: message.requestId, ok: true, result: { environment: index } }));
      });
    }
    assert.deepEqual(await offices[0].call("alice@fixture.test", "get_schematic", {}), { environment: 0 });
    assert.deepEqual(await offices[1].call("alice@fixture.test", "get_schematic", {}), { environment: 1 });
  } finally { for (const socket of sockets) socket.terminate(); for (const office of offices) office.close(); }
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
