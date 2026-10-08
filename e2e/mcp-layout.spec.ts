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
    const fit = await call('configure_sheet', { fitToSheet: 'apply' });
    expect(fit.pageCount).toBe(1);
    expect(fit.pages[0].legend.w).toBeGreaterThan(0);
    const viewBefore = await page.evaluate(async () => (await import('/src/store.ts')).useSchematicStore.getState().printView);
    const print = await client.callTool({ name: 'capture_canvas', arguments: { view: 'print', page: 1 } });
    expect(print.isError).not.toBe(true);
    const printImage = (print.content as Array<{ type: string; data: string }>).find(c => c.type === 'image')!;
    const printPng = Buffer.from(printImage.data, 'base64');
    expect(printPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(printPng.readUInt32BE(16)).toBeLessThanOrEqual(1600);
    expect(printPng.equals(png)).toBe(false);
    const routeMidpoints = await page.evaluate(async () => {
      const s = (await import('/src/store.ts')).useSchematicStore.getState();
      return Object.values(s.routedEdges).flatMap(r => r.segments).filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 40).map(s => ({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }));
    });
    const pixelsSeen = await page.evaluate(async ({ data, bounds, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      let count = 0;
      const reduction = img.width / bounds.w;
      let wireSamples = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 220 || pixels[i + 1] < 220 || pixels[i + 2] < 220) count++;
      }
      for (const p of points) {
        const x = Math.round((p.x - bounds.x) * reduction), y = Math.round((p.y - bounds.y) * reduction);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const i = ((y + dy) * img.width + x + dx) * 4;
          if (pixels[i] > 200 && pixels[i + 1] < 100 && pixels[i + 2] < 100) wireSamples++;
        }
      }
      return { count, wireSamples };
    }, { data: printImage.data, bounds: fit.pages[0].rect, points: routeMidpoints });
    expect(pixelsSeen.count).toBeGreaterThan(3000);
    expect(pixelsSeen.wireSamples).toBeGreaterThan(0);
    const printPath = testInfo.outputPath('mcp-print-capture.png');
    await writeFile(printPath, printPng);
    await testInfo.attach('MCP print image', { path: printPath, contentType: 'image/png' });
    expect((await client.callTool({ name: 'capture_canvas', arguments: { view: 'print', page: 2 } })).isError).toBe(true);
    expect(await page.evaluate(async () => (await import('/src/store.ts')).useSchematicStore.getState().printView)).toBe(viewBefore);
    await call('move_device', { nodeId: display.nodeId, x: 2800, y: 200 });
    const multipage = await call('configure_sheet');
    expect(multipage.pageCount).toBeGreaterThan(1);
    expect((await client.callTool({ name: 'capture_canvas', arguments: { view: 'print', page: multipage.pageCount } })).isError).not.toBe(true);
    await call('move_device', { nodeId: display.nodeId, x: display.absoluteBounds.x, y: display.absoluteBounds.y });
    await call('set_connection_stubs', { connectionId: schematic.connections[0].id, enabled: false });
    schematic = await call('get_schematic');
    expect(schematic.connections).toHaveLength(1);
    expect(schematic.stubs).toHaveLength(0);
    expect(schematic.connections[0]).toMatchObject({ source: endpoint.nodeId, target: display.nodeId });
    expect(schematic.devices.find((d: { nodeId: string }) => d.nodeId === display.nodeId).ports[0].label).toBe('HDMI I/P 1');
    const room = await call('create_room', { label: 'Table', x: 50, y: 150, width: 300, height: 250 });
    await call('place_device_in_room', { deviceId: endpoint.nodeId, roomId: room.roomId, x: 40, y: 70 });
    await call('move_device', { nodeId: endpoint.nodeId, x: 50, y: 80 });
    expect(await call('get_device', { nodeId: endpoint.nodeId })).toMatchObject({ parentId: room.roomId, absoluteBounds: { x: 100, y: 230 } });
    await call('update_room', { roomId: room.roomId, fitToChildren: true });
    await call('delete_room', { roomId: room.roomId });
    const note = await call('add_note', { text: Array.from({ length: 7 }, (_, i) => `Engineering note ${i + 1}: verified cable and power requirements.`).join('\n'), x: 100, y: 500, width: 500 });
    await expect.poll(async () => page.locator('.react-flow__node-note [contenteditable]').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
    await call('update_note', { noteId: note.noteId, width: 550 });
    const logo = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 120; c.height = 60;
      const ctx = c.getContext('2d')!; ctx.fillStyle = 'black'; ctx.font = 'bold 40px sans-serif'; ctx.fillText('TS', 5, 45);
      return c.toDataURL('image/png');
    });
    await call('configure_sheet', { titleBlockLayout: 'tateside', titleBlock: { company: 'Tateside', venue: 'Client', showName: 'Meeting Room', designer: 'Sean', date: '08.10.26', revision: 'A', logo,
      drawingTitle: 'Meeting room with full engineering notes and verified physical Ports — a long title that must stay inside its own cell',
      customFields: [{ id: 'drawingNo', label: 'Drawing No.', value: 'TS-AV-GMR-001' }, { id: 'scale', label: 'Scale', value: 'NTS' }] }, legend: { labels: { hdmi: 'HDMI Video' } } });
    const finalFit = await call('configure_sheet', { fitToSheet: 'apply' });
    expect(finalFit.scale).toBeGreaterThan(1);
    await page.evaluate(async () => (await import('/src/store.ts')).useSchematicStore.getState().setPrintView(true));
    await expect(page.locator('.page-boundary-overlay')).toContainText('Tateside');
    await expect(page.locator('.page-boundary-overlay')).toContainText('TS-AV-GMR-001');
    await expect(page.locator('.page-boundary-overlay')).toContainText('NTS');
    await expect(page.locator('.page-boundary-overlay')).toContainText('HDMI Video');
    const round3 = await client.callTool({ name: 'capture_canvas', arguments: { view: 'print' } });
    expect(round3.isError).not.toBe(true);
    const round3Image = (round3.content as Array<{ type: string; data: string }>).find(c => c.type === 'image')!;
    const round3Path = testInfo.outputPath('mcp-round3-print.png');
    await writeFile(round3Path, Buffer.from(round3Image.data, 'base64'));
    await testInfo.attach('Round 3 title and notes', { path: round3Path, contentType: 'image/png' });
  } finally { await client.close(); }
});
