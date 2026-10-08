import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

test('Claude-compatible MCP previews rooms, imports selected kit and publishes a local Device from Properties', async ({ page }) => {
  const source = { id: 'project-camera', version: 1, label: 'Project Camera', manufacturer: 'Fixture', modelNumber: 'Camera', category: 'Sources', deviceType: 'camera',
    ports: [{ id: 'video', label: 'HDMI Out', signalType: 'hdmi', connectorType: 'hdmi', direction: 'output' }] };
  const item = (model: string, room: string, matched: boolean, quantity = 1) => ({ manufacturer: 'Fixture', model, room, quantity,
    description: null, sourceLineText: null, normalizedLookupKey: model, status: matched ? 'already_in_library' : 'missing',
    exactMatch: matched ? { id: source.id, label: source.label, manufacturer: source.manufacturer, modelNumber: source.modelNumber, normalizedLookupKey: model, matchReason: 'exact' } : null,
    possibleMatches: [], portReuseCandidates: [] });
  const results = [item('Camera', 'Boardroom', true, 2), item('Local Camera', 'Boardroom', false), item('Camera', 'Lobby', true)];
  let published: Record<string, unknown> | undefined;
  await page.route('**/api/tateside/devices/templates', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.source).toBe('device-properties-review');
      published = { ...body.templates[0], id: 'published-local-camera', version: 1 };
      await route.fulfill({ json: { templates: [published] } });
    } else await route.fulfill({ json: published ? [source, published] : [source] });
  });
  await page.route('**/api/tateside/jetbuilt/projects?*', route => route.fulfill({ json: { projects: [{ id: 'project-test', customId: 'P-TEST', name: 'Fixture Project' }] } }));
  await page.route('**/api/tateside/jetbuilt/import', route => route.fulfill({ json: {
    fileName: 'P-TEST Fixture Project', fileType: 'jetbuilt', extractionModel: 'fixture', extractionReasoningEffort: 'low', extractedCount: 3, results, warnings: []
  } }));
  const client = new Client({ name: 'jetbuilt-office-fixture', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server/dist/index.js')],
    env: { ...process.env as Record<string, string>, EASYSCHEMATIC_MCP_PORT: '18768', EASYSCHEMATIC_MCP_TOKEN: 'jetbuilt-office-fixture-token' }, stderr: 'pipe' });
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
      useSchematicStore.setState({ nodes: [], edges: [], pages: [], customTemplates: [], schematicName: 'Untouched fixture' });
    });
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('button', { name: 'Preferences...' }).click();
    await page.getByRole('button', { name: 'AI (Beta)', exact: true }).click();
    await page.getByLabel('MCP pairing token').fill('jetbuilt-office-fixture-token');
    await page.getByLabel('MCP server port').fill('18768');
    await page.getByLabel('Let my AI assistant read and edit this schematic').check();
    await expect(page.getByRole('status')).toContainText('Connection: connected');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const projects = await call('search_jetbuilt_projects', { query: 'P-TEST' });
    const preview = await call('get_jetbuilt_project', { projectId: projects[0].id });
    expect(preview.rooms.map((room: { name: string }) => room.name)).toEqual(['Boardroom', 'Lobby']);
    expect((await call('get_schematic')).schematicName).toBe('Untouched fixture');
    const started = await call('start_jetbuilt_schematic', { previewId: preview.previewId, rooms: ['Boardroom'] });
    expect(started.deviceCount).toBe(2);
    expect(started.notPlaced[0].model).toBe('Local Camera');
    expect(started.rooms.map((room: { label: string }) => room.label)).toEqual(['Boardroom']);
    await expect(call('start_jetbuilt_schematic', { previewId: preview.previewId })).rejects.toThrow(/not empty/);

    const localTemplate = { manufacturer: 'Fixture', modelNumber: 'Local Camera', label: 'Local Camera', shortName: 'Local', category: 'Sources', deviceType: 'camera',
      ports: [{ id: 'input', label: 'HDMI In', direction: 'input', signalType: 'hdmi', connectorType: 'hdmi' }],
      classificationConfidence: 'medium', evidenceRefs: [{ type: 'official-product-page', url: 'https://example.test/local-camera', note: 'Isolated fixture' }] };
    const local = await call('create_local_device', { template: localTemplate, x: 700, y: 100 });
    const target = await call('get_device', { nodeId: local.nodeId });
    const sourceDevice = await call('get_device', { nodeId: started.devices[0].nodeId });
    await call('connect_devices', { sourceNodeId: sourceDevice.nodeId, sourcePortId: sourceDevice.ports[0].id, targetNodeId: target.nodeId, targetPortId: target.ports[0].id });
    expect(published).toBeUndefined();
    await page.evaluate(async nodeId => {
      const { useSchematicStore } = await import('/src/store.ts');
      useSchematicStore.getState().setEditingNodeId(nodeId);
    }, local.nodeId);
    await page.getByRole('button', { name: 'Add to TateSide Library', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Add Device to TateSide Library' });
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: 'Save To TateSide Library', exact: true }).click();
    await expect(review).not.toBeVisible();
    expect(published).toMatchObject({ evidenceRefs: localTemplate.evidenceRefs, classificationConfidence: 'medium', reviewStatus: 'human-reviewed' });
    const after = await call('get_device', { nodeId: local.nodeId });
    expect(after.ports[0].id).toBe(target.ports[0].id);
    expect((await call('get_schematic')).connectionCount).toBe(1);
    const linked = await page.evaluate(async nodeId => {
      const { useSchematicStore } = await import('/src/store.ts');
      return useSchematicStore.getState().nodes.find(entry => entry.id === nodeId)?.data.templateId;
    }, local.nodeId);
    expect(linked).toBe('published-local-camera');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/jetbuilt-device-properties.png' });
  } finally { await client.close(); }
});
