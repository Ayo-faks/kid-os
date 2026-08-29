import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(e2eDir, '..');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3001';
const port = new URL(baseURL).port || '3001';
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === 'true';

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  globalSetup: './global-setup.ts',
  outputDir: 'test-results/mock',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: 'pnpm dev',
        cwd: webDir,
        env: {
          CAREOS_E2E_AUTH_BYPASS: 'true',
          CAREOS_E2E_STATIC_DATA: 'true',
          NEXTAUTH_SECRET: 'careos-e2e-secret',
          NEXTAUTH_URL: baseURL,
          PHASE1_CORRELATION_ID: process.env.PHASE1_CORRELATION_ID ?? '',
          WEB_PORT: port,
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: baseURL,
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { height: 900, width: 1440 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], viewport: { height: 844, width: 390 } },
    },
  ],
});
