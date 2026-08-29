import { expect } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3001';

export default async function globalSetup(): Promise<void> {
  const response = await fetch(setupProbeURL(baseURL), { redirect: 'manual' });
  expect(response.status).toBeLessThan(500);
}

function setupProbeURL(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.protocol === 'https:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    parsed.protocol = 'http:';
  }
  return parsed.toString();
}
