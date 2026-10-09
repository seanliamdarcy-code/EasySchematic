import { test, expect } from '@playwright/test';

test('room selection scopes review and schematic creation while preserving all-room import', async ({ page }) => {
  const templates = ['Boardroom', 'Training Room', 'Unassigned'].map((room, index) => ({
    id: `room-device-${index}`, label: `${room} Display`, manufacturer: 'Fixture', modelNumber: `Display-${index}`,
    deviceType: 'display', category: 'Displays', ports: [], version: 1,
  }));
  const results = templates.map((template, index) => ({
    manufacturer: template.manufacturer, model: template.modelNumber, quantity: 1,
    room: index === 2 ? null : ['Boardroom', 'Training Room'][index], system: 'AV',
    importItemId: `line-${index}`, status: 'already_in_library', sourceKind: 'standalone',
    exactMatch: { id: template.id, label: template.label, manufacturer: template.manufacturer, modelNumber: template.modelNumber },
    possibleMatches: [], portReuseCandidates: [],
  }));
  await page.route('**/api/tateside/devices/templates', (route) => route.fulfill({ json: templates }));
  await page.route('**/api/tateside/jetbuilt/status', (route) => route.fulfill({ json: { ready: true, projectCount: 1, clientCount: 0 } }));
  await page.route('**/api/tateside/jetbuilt/projects?*', (route) => route.fulfill({
    json: { projects: [{ id: 'fixture-project', customId: 'P-TEST', name: 'Room Scope Test', itemCount: 3 }] },
  }));
  await page.route('**/api/tateside/jetbuilt/import', (route) => route.fulfill({
    json: { fileName: 'P-TEST', fileType: 'jetbuilt', extractedCount: 3, extractionModel: 'fixture', extractionReasoningEffort: 'low', results, warnings: [] },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start New Project', exact: true }).click();
  await page.getByPlaceholder('Search P number or project name, for example P-5844 or O2 Meeting Rooms').fill('P-TEST');
  await page.getByRole('button', { name: 'Search Jetbuilt', exact: true }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const scope = page.getByRole('combobox', { name: 'Room scope' });
  await expect(scope).toHaveValue('');
  await scope.selectOption('Boardroom');
  await page.getByRole('button', { name: 'Review outcomes →' }).click();
  await page.locator('summary').filter({ hasText: 'Already in TateSide library' }).click();
  await expect(page.getByText('Fixture Display-1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fixture Display-0', { exact: true })).toBeVisible();
  await scope.selectOption('');
  await expect(page.getByText('Fixture Display-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture Display-2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Back to resolution' }).click();
  await scope.selectOption('Unassigned');
  await expect(page.getByText('Fixture Display-0', { exact: true })).toHaveCount(0);
  await scope.selectOption('Boardroom');
  await page.getByRole('button', { name: 'Start schematic', exact: true }).click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-room')).toContainText('Boardroom');
});
