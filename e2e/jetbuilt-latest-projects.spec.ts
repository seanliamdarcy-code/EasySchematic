import { test, expect } from '@playwright/test';

test('latest projects load on opening, scroll, retry, deduplicate and start the selected project', async ({ page }) => {
  const projects = Array.from({ length: 70 }, (_, i) => ({
    id: String(i), customId: `P-${i}`, name: `Latest Project ${i}`, updatedAt: '2026-10-07',
  }));
  const offsets: number[] = [];
  let failNextPage = true;
  await page.route('**/api/tateside/jetbuilt/status', route => route.fulfill({ json: { projectCount: 70, clientCount: 0 } }));
  await page.route('**/api/tateside/jetbuilt/projects?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get('latest')).toBe('true');
    expect(params.get('limit')).toBe('50');
    const offset = Number(params.get('offset'));
    offsets.push(offset);
    if (offset === 50 && failNextPage) {
      failNextPage = false;
      await route.fulfill({ status: 503, json: { error: 'Fixture temporarily unavailable' } });
      return;
    }
    const batch = offset === 0 ? projects.slice(0, 50) : [projects[49], ...projects.slice(51)];
    await route.fulfill({ json: { projects: batch, total: 70, hasMore: offset === 0 } });
  });
  const template = { id: 'fixture-display', label: 'Fixture Display', manufacturer: 'Fixture', modelNumber: 'Display', deviceType: 'display', category: 'Displays', ports: [] };
  await page.route('**/api/tateside/devices/templates', route => route.fulfill({ json: [template] }));
  await page.route('**/api/tateside/jetbuilt/import', async route => {
    expect(route.request().postDataJSON().projectId).toBe('69');
    await route.fulfill({ json: {
      fileName: 'P-69', fileType: 'jetbuilt', extractedCount: 1, results: [{
        manufacturer: 'Fixture', model: 'Display', quantity: 1, room: 'Boardroom',
        status: 'already_in_library', exactMatch: template, possibleMatches: [], portReuseCandidates: [],
      }], warnings: [],
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start New Project', exact: true }).click();
  const latest = page.getByRole('region', { name: 'Latest Jetbuilt projects', exact: true });
  const rows = latest.getByRole('button', { name: /^Start from P-/ });
  await expect(rows).toHaveCount(50);
  const list = latest.getByLabel('Latest project list');
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(latest.getByRole('alert')).toContainText('Fixture temporarily unavailable');
  await expect(rows).toHaveCount(50);
  await latest.getByRole('button', { name: 'Retry loading projects' }).click();
  await expect(rows).toHaveCount(69);
  await expect(latest.getByText('All projects loaded', { exact: true })).toBeVisible();
  expect(offsets).toEqual([0, 50, 50]);
  await list.evaluate(el => { el.scrollTop = 0; });
  await latest.getByRole('button', { name: 'Refresh latest' }).click();
  await expect(rows).toHaveCount(50);
  // Exercise the fallback without scrolling into view and triggering auto-pagination first.
  await latest.getByRole('button', { name: 'Load more projects' }).evaluate(button => (button as HTMLButtonElement).click());
  await expect(rows).toHaveCount(69);
  await latest.getByRole('button', { name: 'Start from P-69', exact: true }).click();
  await page.getByRole('button', { name: 'Start schematic', exact: true }).click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-room')).toContainText('Boardroom');
});
