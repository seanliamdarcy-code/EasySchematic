import { test, expect } from '@playwright/test';

test.describe('EasySchematic smoke', () => {
  test('loads the editor shell', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Brand + primary chrome
    await expect(page.getByText('Tateside Schematic').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Insert' })).toBeVisible();

    // React Flow canvas mounts
    await expect(page.locator('.react-flow')).toBeVisible();

    // Mobile gate should not block desktop viewports
    await expect(
      page.getByText('EasySchematic is designed for desktop browsers.'),
    ).toHaveCount(0);

    // No hard page errors during boot (ignore noisy 3rd-party noise if any)
    const fatal = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('Download the React DevTools'),
    );
    expect(fatal, `Unexpected console/page errors:\n${fatal.join('\n')}`).toEqual([]);
  });

  test('opens the File menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'File' }).click();
    // Menu items render as buttons with labels like "New", "Open…", etc.
    await expect(page.getByRole('button', { name: /New/i }).first()).toBeVisible();
  });
});
