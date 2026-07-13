import { expect, test, type Request } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shotDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'library-doctor-visual-preview');

const proposedValue = {
  proposedTemplate: {
    manufacturer: 'Neat', modelNumber: 'Neat Center', label: 'Neat Center', shortName: 'Center',
    category: 'Sources', deviceType: 'camera', roleTags: ['conferencing'], deviceCapabilities: ['poe-powered'],
    heightMm: 297, widthMm: 84, depthMm: 84, weightKg: 1.47,
    ports: [
      { id: 'ethernet-poe', label: 'PoE / Ethernet', signalType: 'ethernet', direction: 'bidirectional', connectorType: 'rj45', section: 'Network / Power' },
      { id: 'usb-c-debug', label: 'USB-C Debug Only', signalType: 'usb', direction: 'bidirectional', connectorType: 'usb-c', section: 'Service' },
    ],
    searchTerms: ['Neat Center', 'NEATCENTER-SE', '360 camera'], referenceUrl: 'https://neat.no/center/',
  },
  proposalMetadata: {
    identityAliases: ['NEATCENTER-SE', 'NEATCENTERSE', 'Neat Center SE'],
    historicalUsageEvidence: { occurrences: 7, quantity: 7, projects: 1, rooms: 7, completedProjects: 1, priorityScore: 62.5 },
    operationalNotes: ['Pairs over the wired subnet.', 'USB-C is debug only.'],
    duplicateCheck: {
      exactCanonicalCollisions: [], exactAliasCollisions: [], searchTermCollisions: [],
      possibleRelatedTemplates: [{ id: 'neat-pad', manufacturer: 'Neat', modelNumber: 'Neat Pad', label: 'Neat Pad', reason: 'same manufacturer' }],
    },
    taxonomyValidation: [
      { kind: 'category', values: ['Sources'], unknownValues: [] },
      { kind: 'deviceType', values: ['camera'], unknownValues: [] },
      { kind: 'roleTag', values: ['conferencing'], unknownValues: [] },
    ],
  },
};

const proposal = {
  id: '2ff97b5c-8edb-41d7-9406-70ce98cdedb7', templateId: 'new-template:local-only', manufacturer: 'Neat', modelNumber: 'Neat Center',
  sourceIssueCode: null, sourceIssueGroup: null, sourceCurrentValue: null, field: 'template', currentValue: null, proposedValue,
  proposalType: 'new-template', confidence: 'high', risk: 'medium',
  evidenceRefs: [{ type: 'official-product-page', title: 'Neat Center', url: 'https://neat.no/center/' }],
  rationale: 'Canonical Neat Center is missing.', status: 'pending', createdAt: '2026-07-12T19:04:08.585Z', createdBy: 'chatgpt-mcp',
  reviewedAt: null, reviewedBy: null, reviewNote: null, supersedesProposalId: null, generationKey: 'fixture:new-template',
  preview: { field: 'template', currentValue: null, proposedValue, readOnly: true },
};

test('new-template visual preview is complete, read-only, and write-free', async ({ page }) => {
  const writes: Array<{ method: string; url: string }> = [];
  page.on('request', (request: Request) => {
    if (request.url().includes('/api/tateside/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
      writes.push({ method: request.method(), url: request.url() });
    }
  });
  await page.route('**/api/tateside/library-doctor/proposals**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/history')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proposals: [proposal] }) });
    }
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const storageBefore = await page.evaluate(() => JSON.stringify(localStorage));
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('button', { name: 'Library Doctor...' }).click();
  const libraryDoctor = page.getByRole('dialog', { name: 'Library Doctor' });
  await expect(libraryDoctor).toBeVisible();

  await expect(libraryDoctor.getByRole('combobox', { name: 'Proposal type' }).locator('option[value="new-template"]')).toHaveCount(1);
  await expect(libraryDoctor.getByText('PROPOSED TEMPLATE — NOT APPLIED', { exact: true })).toBeVisible();
  await expect(libraryDoctor.getByText('No existing template', { exact: true })).toBeVisible();
  const preview = libraryDoctor.getByLabel('Read-only proposed device block for Neat Center');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('Neat Center', { exact: true })).toBeVisible();
  await expect(preview.getByText(/PoE \/ Ethernet/)).toBeVisible();
  await expect(preview.getByText(/USB-C Debug Only/)).toBeVisible();
  await expect(libraryDoctor.getByText('Occurrences', { exact: true })).toBeVisible();
  await expect(libraryDoctor.getByText('7', { exact: true }).first()).toBeVisible();
  await expect(libraryDoctor.getByText(/Neat Pad/)).toBeVisible();
  await expect(libraryDoctor.getByText('Taxonomy validation', { exact: true })).toBeVisible();
  await expect(libraryDoctor.getByText('USB-C is debug only.', { exact: true })).toBeVisible();
  await expect(libraryDoctor.getByText('Canonical Neat Center is missing.', { exact: true })).toBeVisible();

  const raw = libraryDoctor.getByText('Raw proposal JSON', { exact: true });
  await expect(raw).toBeVisible();
  await expect(raw.locator('xpath=..')).not.toHaveAttribute('open', '');

  await preview.locator('.react-flow__node').dblclick();
  let properties = page.getByRole('dialog', { name: 'Proposed Template Properties' });
  await expect(properties).toBeVisible();
  await expect(properties.getByText('PoE / Ethernet', { exact: true })).toBeVisible();
  await expect(properties.getByText('297 mm', { exact: true })).toBeVisible();
  await expect(properties.locator('input, textarea, select')).toHaveCount(0);
  await expect(properties.getByRole('button')).toHaveCount(1);
  await expect(properties.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await properties.getByRole('button', { name: 'Close', exact: true }).click();

  await libraryDoctor.getByRole('button', { name: 'Open read-only properties', exact: true }).click();
  properties = page.getByRole('dialog', { name: 'Proposed Template Properties' });
  await expect(properties).toBeVisible();
  await properties.getByRole('button', { name: 'Close', exact: true }).click();
  await raw.click();
  await expect(libraryDoctor.getByText(/"proposedTemplate"/)).toBeVisible();

  await page.screenshot({ path: path.join(shotDir, 'neat-center-visual-preview.png'), fullPage: true });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(storageBefore);
  expect(writes).toEqual([]);
});
