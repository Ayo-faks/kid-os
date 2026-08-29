import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost';

export default defineConfig({
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  globalSetup: resolve(e2eDir, 'global-setup.ts'),
  outputDir: resolve(e2eDir, 'test-results', 'phase4-real-stack'),
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'json',
          {
            outputFile: resolve(e2eDir, 'test-results', 'phase4-real-stack.json'),
          },
        ],
      ]
    : 'list',
  testDir: resolve(e2eDir, 'real-stack'),
  timeout: 240_000,
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  workers: 1,
  projects: [
    {
      name: 'chromium-real-stack',
      use: { ...devices['Desktop Chrome'], viewport: { height: 900, width: 1440 } },
    },
    {
      name: 'mobile-chromium-real-stack',
      use: { ...devices['Pixel 7'], viewport: { height: 844, width: 390 } },
    },
  ],
});
