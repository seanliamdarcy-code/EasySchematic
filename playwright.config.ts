import { defineConfig, devices } from '@playwright/test';

/**
 * Live browser tests for EasySchematic.
 * Starts isolated API and Vite servers unless PLAYWRIGHT_BASE_URL is set.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // App gates on <768px; always use a desktop viewport for e2e.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [{
        command: 'npm run tateside:api',
        env: {
          TATESIDE_API_HOST: '127.0.0.1',
          TATESIDE_API_PORT: '8797',
          TATESIDE_DATA_DIR: '.tateside-test-data/browser',
          TATESIDE_DB_PATH: '.tateside-test-data/browser.db',
          TATESIDE_SCHEMATIC_REPOSITORY_PATH: '.tateside-test-data/browser-schematics',
          TATESIDE_DISABLE_SHAREPOINT: '1',
          TATESIDE_REQUIRE_ACCESS_IDENTITY: '0',
          TATESIDE_DYNAMIC_TAXONOMY_ENABLED: '1',
        },
        url: 'http://127.0.0.1:8797/health',
        reuseExistingServer: false,
        timeout: 120_000,
      }, {
        command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
        env: {
          EASYSCHEMATIC_FULL_STACK_DEV: '1',
          TATESIDE_DEV_API_TARGET: 'http://127.0.0.1:8797',
        },
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: false,
        timeout: 120_000,
      }],
});
