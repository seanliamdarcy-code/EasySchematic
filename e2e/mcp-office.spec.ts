import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { createOfficeService } from '../mcp-server/src/office';

test('office sign-in pairs the opening editor without a laptop token and turns off on reload', async ({ page, context }) => {
  const origin = 'http://127.0.0.1:5173';
  const service = createOfficeService(async () => ({ email: 'office-fixture@example.test', expires: Date.now() + 60000 }), [origin]);
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const address = service.server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server failed.');
  const base = `http://127.0.0.1:${address.port}`;
  await context.route('https://office-fixture.example.test/pair?*', async route => {
    const response = await route.fetch({ url: base + new URL(route.request().url()).pathname + new URL(route.request().url()).search });
    await route.fulfill({ response });
  });
  await page.addInitScript((fixtureUrl) => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(String(url) === 'wss://office-fixture.example.test/editor' ? fixtureUrl : url, protocols);
      }
    };
  }, base.replace('http:', 'ws:') + '/editor');
  try {
    await page.goto('/'); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('button', { name: 'Preferences...' }).click();
    await page.getByRole('button', { name: 'AI (Beta)', exact: true }).click();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Connect my office account', exact: true }).click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: 'Connect my office account', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connection:' })).toContainText('Connection: connected');
    await expect(page.getByLabel('MCP pairing token')).toHaveCount(0);
    const schematic = await service.call('office-fixture@example.test', 'get_schematic', {}) as { deviceCount: number };
    expect(schematic.deviceCount).toBeGreaterThanOrEqual(0);
    await page.reload();
    await expect.poll(async () => service.call('office-fixture@example.test', 'get_schematic', {}).then(() => 'connected', () => 'disconnected')).toBe('disconnected');
  } finally { service.close(); }
});
