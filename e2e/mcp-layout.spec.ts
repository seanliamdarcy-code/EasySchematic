import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

test('layout tools preserve editable topology and return a real canvas PNG through MCP', async ({ page }, testInfo) => {
  const client = new Client({ name: 'layout-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server/dist/index.js')],
    env: { ...process.env as Record<string, string>, EASYSCHEMATIC_MCP_PORT: '18769', EASYSCHEMATIC_MCP_TOKEN: 'layout-fixture-only' }, stderr: 'pipe' });
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
      const { handlers } = await import('/src/mcpBridge.ts');
      useSchematicStore.getState().newSchematic();
      await handlers.create_local_device({ template: { manufacturer: 'Fixture', modelNumber: 'Display', label: 'Display', shortName: 'Display', category: 'Displays', deviceType: 'display',
        ports: [{ id: 'video', label: 'HDMI IN', direction: 'input', connectorType: 'hdmi', signalType: 'hdmi' }] }, x: 500, y: 200 });
      useSchematicStore.setState({ mcpBridgePort: 18769, mcpBridgeToken: 'layout-fixture-only', mcpBridgeEnabled: true, mcpBridgeOffice: false });
    });
    await expect.poll(async () => page.evaluate(async () => (await import('/src/store.ts')).useSchematicStore.getState().mcpBridgeStatus)).toBe('connected');
    const initial = await call('get_schematic');
    const display = initial.devices[0];
    await call('rename_ports', { nodeId: display.nodeId, ports: [{ portId: display.ports[0].id, label: 'HDMI I/P 1' }] });
    const batch = await call('add_external_endpoints', { endpoints: [{ label: 'LAPTOP HDMI', direction: 'output', signalType: 'hdmi', connectorType: 'hdmi', x: 100, y: 200 }] });
    const endpoint = batch.results[0].result;
    await call('connect_devices', { sourceNodeId: endpoint.nodeId, sourcePortId: endpoint.ports[0].id, targetNodeId: display.nodeId, targetPortId: display.ports[0].id });
    let schematic = await call('get_schematic');
    await call('set_connection_stubs', { connectionId: schematic.connections[0].id, enabled: true });
    schematic = await call('get_schematic');
    expect(schematic.stubs).toHaveLength(2);
    await call('update_stub', { stubId: schematic.stubs[0].stubId, label: 'TO DISPLAY', x: 300, y: 210 });
    await expect(page.locator('.react-flow__node-stub-label').filter({ hasText: 'TO DISPLAY' })).toBeVisible();
    await call('configure_sheet', { paperId: 'iso-a3', orientation: 'landscape', titleBlock: { drawingTitle: 'Boardroom', revision: 'A' }, legend: { enabled: true } });
    const capture = await client.callTool({ name: 'capture_canvas', arguments: {} });
    expect(capture.isError).not.toBe(true);
    const image = (capture.content as Array<{ type: string; data: string; mimeType: string }>).find(c => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    const png = Buffer.from(image.data, 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBeLessThanOrEqual(1600);
    const imagePath = testInfo.outputPath('mcp-layout-capture.png');
    await writeFile(imagePath, png);
    await testInfo.attach('MCP canvas image', { path: imagePath, contentType: 'image/png' });
    await call('set_connection_stubs', { connectionId: schematic.connections[0].id, enabled: false });
    schematic = await call('get_schematic');
    expect(schematic.connections).toHaveLength(1);
    expect(schematic.stubs).toHaveLength(0);
    expect(schematic.connections[0]).toMatchObject({ source: endpoint.nodeId, target: display.nodeId });
    expect(schematic.devices.find((d: { nodeId: string }) => d.nodeId === display.nodeId).ports[0].label).toBe('HDMI I/P 1');
  } finally { await client.close(); }
});
