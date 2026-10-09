import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

test('Grok consent preserves browser Origin and returns the approved OAuth callback', async ({ page, request }) => {
  const diagnostics: string[] = [];
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('requestfailed', req => diagnostics.push(req.failure()?.errorText ?? 'Request failed'));
  const base = 'http://127.0.0.1:18769';
  const origin = 'https://connector.fixture.test';
  const token = 'grok-browser-fixture-token-at-least-32-chars';
  const fixtureProcess = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createHttpApp } from './mcp-server/dist/http-app.js';
    const { app } = createHttpApp(new URL('${origin}'), '${token}', async () => ({}));
    app.listen(18769, '127.0.0.1', () => console.log('ready'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      fixtureProcess.stdout.once('data', () => resolve());
      fixtureProcess.once('error', reject);
      fixtureProcess.once('exit', code => reject(new Error(`Fixture exited: ${code}`)));
    });
    const registration = await request.post(base + '/register', { data: {
      redirect_uris: ['https://grok.com/fixture-callback'], client_name: 'Grok fixture', token_endpoint_auth_method: 'none',
    } });
    expect(registration.status()).toBe(201);
    const registered = await registration.json();
    const query = new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'https://grok.com/fixture-callback',
      response_type: 'code', code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256', scope: 'schematic', resource: origin + '/mcp' });
    // All external-looking URLs are fulfilled by this isolated fixture.
    let callback: URL | undefined;
    await page.route('**/*', async route => {
      const incoming = new URL(route.request().url());
      if (incoming.origin === origin) {
        const response = await route.fetch({ url: base + incoming.pathname + incoming.search, maxRedirects: 0 });
        if (incoming.pathname === '/consent' && response.status() === 303) {
          callback = new URL(response.headers().location);
          // Capture the redirect locally: no fixture request reaches the real Grok service.
          await route.fulfill({ contentType: 'text/html', body: '<h1>OAuth approval accepted</h1>' });
          return;
        }
        await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
      } else await route.abort();
    });
    await page.goto(origin + '/authorize?' + query);
    await page.getByLabel('Existing EasySchematic pairing token').fill(token);
    await page.getByRole('button', { name: 'Allow Grok access' }).click();
    await expect(page.getByRole('heading', { name: 'OAuth approval accepted' })).toBeVisible();
    expect(callback?.origin).toBe('https://grok.com');
    expect(callback?.searchParams.get('code')).toBeTruthy();
  } finally {
    if (diagnostics.length) console.log(diagnostics.map(line => line.replace(/https?:\/\/[^\s"']+/g, '[fixture URL]')).join('\n'));
    fixtureProcess.kill();
  }
});
