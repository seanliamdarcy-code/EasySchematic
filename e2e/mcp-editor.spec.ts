import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

test('MCP builds from an empty canvas and requires human publication for missing devices', async ({page}) => {
  const client = new Client({name: 'editor-integration-test', version: '1.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.resolve('mcp-server/dist/index.js')],
    env: {...process.env as Record<string,string>, EASYSCHEMATIC_MCP_PORT: '18765', EASYSCHEMATIC_MCP_TOKEN: 'integration-test-token-only'}, stderr: 'pipe'});
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({name, arguments: args});
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as Array<{text:string}>)[0].text);
  };
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(34);
    await page.setExtraHTTPHeaders({'CF-Access-Authenticated-User-Email': 'mcp-fixture@example.test'});
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      const {useSchematicStore} = await import('/src/store.ts');
      useSchematicStore.setState({nodes: [], edges: [], schematicName: 'MCP isolated fixture'});
    });
    await page.getByRole('button', {name: 'File', exact: true}).click();
    await page.getByRole('button', {name: 'Preferences...'}).click();
    await page.getByRole('button', {name: 'AI (Beta)', exact: true}).click();
    await page.getByLabel('MCP pairing token').fill('integration-test-token-only');
    await page.getByLabel('MCP server port').fill('18765');
    await page.getByLabel('Let my AI assistant read and edit this schematic').check();
    await expect(page.getByRole('status')).toContainText('Connection: connected');
    await page.getByRole('button', {name: 'Close', exact: true}).click();
    expect((await call('get_schematic')).deviceCount).toBe(0);
    const model = `Fixture Camera ${Date.now()}`;
    expect(await call('search_templates', {query: model})).toEqual([]);
    expect(await call('get_library_taxonomy')).toBeTruthy();
    const proposal = await call('propose_missing_device', {
      proposedTemplate: {manufacturer: 'MCP Fixture', modelNumber: model, label: model, shortName: 'Camera', category: 'Sources', deviceType: 'camera',
        ports: [{id: 'video', label: 'HDMI OUT', connectorType: 'hdmi', signalType: 'hdmi', direction: 'output'}, {id: 'input', label: 'HDMI IN', connectorType: 'hdmi', signalType: 'hdmi', direction: 'input'}]},
      evidenceRefs: [{type: 'official-product-page', url: 'https://example.test/fixture-camera'}], rationale: 'Isolated test fixture, not a real product.',
      classificationConfidence: 'high', qualityGates: {identityVerifiedByCaller: true, officialEvidenceDeclaredByCaller: true,
        noValidDataOmittedConfirmedByCaller: true, dimensionsDeclaration: 'unavailable', physicalPortsDeclaration: 'complete'}
    });
    expect(proposal.success).toBe(true);
    await expect(call('add_approved_device', {proposalId: proposal.proposalId})).rejects.toThrow(/approved and published/);
    const anonymous = await page.request.post(`/api/tateside/library-doctor/proposals/${proposal.proposalId}/publish`, {headers: {'CF-Access-Authenticated-User-Email': ''}});
    expect(anonymous.status()).toBe(401);
    await page.getByRole('button', {name: 'File', exact: true}).click();
    await page.getByRole('button', {name: 'Library Doctor...'}).click();
    const dialog = page.getByRole('dialog', {name: 'Library Doctor'});
    await dialog.getByRole('row').filter({hasText: model}).click();
    page.once('dialog', event => event.accept());
    await dialog.getByRole('button', {name: 'Accept (queue only)', exact: true}).click();
    await expect(dialog.getByText('Accepted in the review queue only. Templates were not modified.')).toBeVisible();
    await expect(call('add_approved_device', {proposalId: proposal.proposalId})).rejects.toThrow(/approved and published/);
    await dialog.getByLabel('Status', {exact: true}).selectOption('accepted');
    await dialog.getByRole('row').filter({hasText: model}).click();
    page.once('dialog', event => event.accept());
    await dialog.getByRole('button', {name: 'Publish approved device'}).click();
    await expect(dialog.getByText('Published to the shared library.', {exact: true})).toBeVisible();
    await dialog.getByLabel('Close Library Doctor').click();
    const added = await call('add_approved_device', {proposalId: proposal.proposalId, x: 50, y: 50});
    const second = await call('add_device', {templateId: (await call('get_device_proposal', {proposalId: proposal.proposalId})).publishedTemplateId, x: 350, y: 50});
    expect((await call('get_schematic')).deviceCount).toBe(2);
    const source = await call('get_device', {nodeId: added.nodeId});
    const target = await call('get_device', {nodeId: second.nodeId});
    const connection = await call('connect_devices', {sourceNodeId: added.nodeId, sourcePortId: source.ports.find((p: {label:string}) => p.label === 'HDMI OUT').id, targetNodeId: second.nodeId, targetPortId: target.ports.find((p: {label:string}) => p.label === 'HDMI IN').id});
    expect((await call('get_schematic')).connectionCount).toBe(1);
    await call('delete_connection', {connectionId: connection.edgeId});
    expect((await call('get_schematic')).connectionCount).toBe(0);
    const room = await call('create_room', {label: 'Test Room', x: 0, y: 0, width: 900, height: 600});
    await call('place_device_in_room', {deviceId: added.nodeId, roomId: room.roomId, x: 30, y: 30});
    await call('move_device', {nodeId: second.nodeId, x: 1000, y: 300});
    expect((await call('get_device', {nodeId: second.nodeId})).parentId).toBeUndefined();
    await call('delete_device', {nodeId: second.nodeId});
    expect((await call('get_schematic')).deviceCount).toBe(1);
    await page.reload();
    await page.waitForLoadState('networkidle');
    const settings = await page.evaluate(async () => {
      const {useSchematicStore} = await import('/src/store.ts');
      const s = useSchematicStore.getState(); return {enabled:s.mcpBridgeEnabled,token:s.mcpBridgeToken};
    });
    expect(settings).toEqual({enabled: false, token: ''});
  } finally { await client.close(); }
});

test('HTTPS test editor can pair with the laptop localhost bridge', async ({page, context}) => {
  await context.grantPermissions(['local-network-access'], {origin:'https://testschematic.tateside.online'});
  const client = new Client({name:'https-editor-test',version:'1.0'});
  const transport = new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp-server/dist/index.js')],
    env:{...process.env as Record<string,string>,EASYSCHEMATIC_MCP_PORT:'18766',EASYSCHEMATIC_MCP_TOKEN:'https-fixture-only',EASYSCHEMATIC_MCP_ORIGINS:'https://testschematic.tateside.online'},stderr:'pipe'});
  try {
    await client.connect(transport);
    // Serve isolated Vite/API fixtures under the real HTTPS Origin. No requests or writes reach the VPS.
    await page.route('https://testschematic.tateside.online/**', async route => {
      const target=route.request().url().replace('https://testschematic.tateside.online','http://127.0.0.1:5173');
      const response=await route.fetch({url:target});
      await route.fulfill({response});
    });
    await page.goto('https://testschematic.tateside.online/');
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.getByRole('button',{name:'File',exact:true}).click();
    await page.getByRole('button',{name:'Preferences...'}).click();
    await page.getByRole('button',{name:'AI (Beta)',exact:true}).click();
    await page.getByLabel('MCP pairing token').fill('https-fixture-only');
    await page.getByLabel('MCP server port').fill('18766');
    await page.getByLabel('Let my AI assistant read and edit this schematic').check();
    await expect(page.getByRole('status')).toContainText('Connection: connected');
    const result=await client.callTool({name:'get_schematic',arguments:{}});
    expect(result.isError).not.toBe(true);
  } finally { await client.close(); }
});

test('missing devices are local, immediately usable, portable and never published', async ({page}) => {
  const client = new Client({name:'local-device-test',version:'1.0'});
  const transport = new StdioClientTransport({command:process.execPath,args:[path.resolve('mcp-server/dist/index.js')],
    env:{...process.env as Record<string,string>,EASYSCHEMATIC_MCP_PORT:'18767',EASYSCHEMATIC_MCP_TOKEN:'local-device-fixture'},stderr:'pipe'});
  const call = async (name:string,args:Record<string,unknown>={}) => {
    const result=await client.callTool({name,arguments:args});
    if(result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as Array<{text:string}>)[0].text);
  };
  const canonicalWrites:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET' && /\/api\/tateside\/(devices|library-doctor)\//.test(request.url())) canonicalWrites.push(request.url());});
  try {
    await client.connect(transport);
    await page.goto('/'); await page.waitForLoadState('networkidle');
    await page.evaluate(async()=>{const {useSchematicStore}=await import('/src/store.ts');useSchematicStore.setState({nodes:[],edges:[],customTemplates:[]});});
    await page.getByRole('button',{name:'File',exact:true}).click();
    await page.getByRole('button',{name:'Preferences...'}).click();
    await page.getByRole('button',{name:'AI (Beta)',exact:true}).click();
    await page.getByLabel('MCP pairing token').fill('local-device-fixture');
    await page.getByLabel('MCP server port').fill('18767');
    await page.getByLabel('Let my AI assistant read and edit this schematic').check();
    await expect(page.getByRole('status')).toContainText('Connection: connected');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    const model=`Local Fixture ${Date.now()}`;
    const template={manufacturer:'Local Fixture',modelNumber:model,label:model,shortName:'Camera',category:'Sources',deviceType:'camera',
      ports:[{id:'hdmi',label:'HDMI OUT',connectorType:'hdmi',signalType:'hdmi',direction:'output'}],
      evidenceRefs:[{type:'official-product-page',url:'https://example.test/local-fixture'}],classificationConfidence:'medium'};
    const invalid={...template,ports:[{...template.ports[0],signalType:'invented-signal'}]};
    await expect(call('create_local_device',{template:invalid})).rejects.toThrow(/Invalid signal/);
    expect((await call('get_schematic')).deviceCount).toBe(0);
    const result=await call('create_local_device',{template,x:120,y:80});
    expect(result).toMatchObject({scope:'local',reused:false,published:false,position:{x:120,y:80}});
    expect(result.templateId).toMatch(/^local-ai-/);
    expect((await call('get_device',{nodeId:result.nodeId})).ports[0].label).toBe('HDMI OUT');
    expect((await call('search_templates',{query:model}))[0].templateId).toBe(result.templateId);
    const duplicate=await call('create_local_device',{template,placeOnCanvas:false});
    expect(duplicate).toMatchObject({templateId:result.templateId,reused:true,scope:'local'});
    expect((await call('get_schematic')).deviceCount).toBe(1);
    const exported=await page.evaluate(async()=>{const {useSchematicStore}=await import('/src/store.ts');return useSchematicStore.getState().exportToJSON();});
    expect(exported.customTemplates).toHaveLength(1);
    expect(exported.customTemplates?.[0]).toMatchObject({id:result.templateId,reviewStatus:'ai-researched',classificationConfidence:'medium',evidenceRefs:template.evidenceRefs});
    await page.reload(); await expect(page.locator('.react-flow')).toBeVisible();
    const local=await page.evaluate(async()=>{const {useSchematicStore}=await import('/src/store.ts');return useSchematicStore.getState().customTemplates;});
    expect(local).toHaveLength(1); expect(local[0].id).toBe(result.templateId);
    expect(canonicalWrites).toEqual([]);
  } finally {await client.close();}
});
