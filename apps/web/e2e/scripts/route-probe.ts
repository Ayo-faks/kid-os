/* eslint-disable no-console */
import { chromium } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost';
const PASSWORD = 'careos-dev-password';
const ROUTES = [
  '/',
  '/documents',
  '/incidents',
  '/incidents/new',
  '/approvals',
  '/rota',
  '/handovers',
  '/comms/email/new',
  '/comms/mattermost',
  '/settings',
  '/residents',
];

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const bad: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) {
      bad.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => bad.push(`pageerror: ${error.message}`));

  await page.goto(`${BASE}/`);
  if (new URL(page.url()).pathname.startsWith('/api/auth/signin')) {
    await page.getByRole('button', { name: /Keycloak/i }).click();
  }
  if (await page.locator('#username').isVisible()) {
    await page.locator('#username').fill('ash.support@careos.local');
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });
  console.log('login ok');

  for (const route of ROUTES) {
    const marker = bad.length;
    const response = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    const status = response?.status() ?? 0;
    const heading = await page
      .locator('h1, h2')
      .first()
      .textContent()
      .catch(() => null);
    console.log(
      `${String(status).padEnd(4)} ${route.padEnd(22)} ${(heading ?? '(no heading)').trim().slice(0, 60)}`,
    );
    for (const entry of bad.slice(marker)) {
      console.log(`       └─ ${entry}`);
    }
  }

  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
