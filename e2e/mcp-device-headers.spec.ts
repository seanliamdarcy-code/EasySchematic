import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

test('make/model Device headers persist, truncate and appear in canvas and print captures', async ({ page }, testInfo) => {
  const client = new Client({ name: 'header-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server/dist/index.js')], env: { ...process.env as Record<string, string>, EASYSCHEMATIC_MCP_PORT: '18773', EASYSCHEMATIC_MCP_TOKEN: 'header-fixture-only' }, stderr: 'pipe' });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  try {
    await client.connect(transport);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      const { useSchematicStore } = await import('/src/store.ts');
      const s = useSchematicStore.getState();
      s.newSchematic();
      // Presentation fixtures only; not assertions about real hardware Port inventories.
      for (const [i, [manufacturer, modelNumber, label]] of [['Neat', 'Neat Bar Pro', 'Video Conferencing Bar'], ['Lightware', 'HDMI-UCX-TPX-RX107', 'Kvm Extender'], ['Lightware', 'UCX-2x1-TPX-TX20', 'Kvm Extender'], ['Samsung', 'QM55C', 'Display']].entries()) {
        const template = { id: `header-fixture-${i}`, manufacturer, modelNumber, label, shortName: 'SHORT', deviceType: 'monitor', ports: [{ id: 'video', label: 'HDMI I/P', direction: 'input', connectorType: 'hdmi', signalType: 'hdmi' }] };
        s.addCustomTemplate(template);
        s.addDevice(template, { x: 200 + (i % 2) * 450, y: 200 + Math.floor(i / 2) * 250 });
      }
      s.setUseShortNames(true);
      useSchematicStore.setState({ mcpBridgePort: 18773, mcpBridgeToken: 'header-fixture-only', mcpBridgeEnabled: true, mcpBridgeOffice: false });
    });
    await expect.poll(async () => page.evaluate(async () => (await import('/src/store.ts')).useSchematicStore.getState().mcpBridgeStatus)).toBe('connected');
    expect(await page.locator('[data-device-header-line="2"]').count()).toBe(0);
    await call('configure_sheet', { deviceHeader: { showManufacturerModel: true } });
    const snapshot = await call('get_schematic');
    expect(snapshot.devices.map((d: { displayHeader: string[] }) => d.displayHeader[1])).toEqual(['Neat Bar Pro', 'Lightware HDMI-UCX-TPX-RX107', 'Lightware UCX-2x1-TPX-TX20', 'Samsung QM55C']);
    await expect(page.locator('[data-device-header-line="2"]')).toHaveCount(4);
    const samsung = snapshot.devices[3];
    await call('set_device_property', { nodeId: samsung.nodeId, properties: { headerLine2: 'Samsung – model TBC' } });
    await expect(page.locator('[data-device-header-line="2"]').filter({ hasText: 'Samsung – model TBC' })).toBeVisible();
    await call('add_external_endpoints', { endpoints: [{ label: 'NETWORK', x: 50, y: 160, direction: 'output', connectorType: 'rj45', signalType: 'ethernet' }] });
    await expect(page.locator('[data-device-header-line="2"]')).toHaveCount(4);
    const node = page.locator(`.react-flow__node[data-id="${samsung.nodeId}"]`);
    const portBefore = (await call('get_device', { nodeId: samsung.nodeId })).portCoordinates[0].absY;
    await call('set_device_property', { nodeId: samsung.nodeId, properties: { showDeviceType: true } });
    await expect(node).toContainText('Monitor');
    expect((await call('get_device', { nodeId: samsung.nodeId })).portCoordinates[0].absY).toBe(portBefore + 20);
    for (const d of snapshot.devices) {
      const block = page.locator(`.react-flow__node[data-id="${d.nodeId}"]`);
      const line = block.locator('[data-device-header-line="2"]');
      const geometry = await block.evaluate(el => {
        const header = el.querySelector('[data-device-header-line="2"]')!.getBoundingClientRect();
        const handle = el.querySelector('.react-flow__handle')!.getBoundingClientRect();
        return { headerBottom: header.bottom, portTop: handle.top, width: (el.firstElementChild as HTMLElement).offsetWidth };
      });
      expect(geometry.width).toBe(180);
      expect(geometry.headerBottom).toBeLessThan(geometry.portTop);
      expect(await line.evaluate(el => getComputedStyle(el).textOverflow)).toBe('ellipsis');
      await expect(line).toHaveAttribute('title', (await call('get_device', { nodeId: d.nodeId })).displayHeader[1]);
    }
    const longOverride = 'Samsung – ' + 'Long manufacturer/model identifier '.repeat(5).trim();
    await call('set_device_property', { nodeId: samsung.nodeId, properties: { headerLine2: longOverride } });
    await expect(node.locator('[data-device-header-line="2"]')).toHaveAttribute('title', longOverride);
    expect(await node.locator('[data-device-header-line="2"]').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await node.evaluate(el => (el.firstElementChild as HTMLElement).offsetWidth)).toBe(180);
    expect((await call('get_device', { nodeId: samsung.nodeId })).displayHeader[1]).toBe(longOverride);
    await call('set_device_property', { nodeId: samsung.nodeId, properties: { headerLine2: 'Samsung – model TBC' } });
    await call('configure_sheet', { paperId: 'iso-a3', orientation: 'landscape' });
    await call('configure_sheet', { fitToSheet: 'apply' });
    for (const view of ['canvas', 'print']) {
      const result = await client.callTool({ name: 'capture_canvas', arguments: view === 'print' ? { view, page: 1 } : {} });
      expect(result.isError).not.toBe(true);
      const image = (result.content as Array<{ type: string; data: string }>).find(c => c.type === 'image')!;
      const filename = testInfo.outputPath(`device-headers-${view}.png`);
      await writeFile(filename, Buffer.from(image.data, 'base64'));
      await testInfo.attach(`Device headers ${view}`, { path: filename, contentType: 'image/png' });
    }
    await page.evaluate(async () => {
      const s = (await import('/src/store.ts')).useSchematicStore.getState();
      const saved = s.exportToJSON();
      s.newSchematic();
      s.importFromJSON(saved);
    });
    await expect(page.locator('[data-device-header-line="2"]')).toHaveCount(4);
    await expect(node.locator('[data-device-header-line="2"]')).toHaveText('Samsung – model TBC');
    await call('configure_sheet', { deviceHeader: { showManufacturerModel: false } });
    await expect(page.locator('[data-device-header-line="2"]')).toHaveCount(0);
    await expect(page.locator('.react-flow__node-device').filter({ hasText: 'Monitor' })).toHaveCount(4);
  } finally { await client.close(); }
});
