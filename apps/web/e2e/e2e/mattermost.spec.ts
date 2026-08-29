import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.describe('Mattermost configuration', () => {
  test('saves a channel mapping and issues a one-time link code', async ({ page }) => {
    await mockMattermostWrites(page);
    await page.goto('/comms/mattermost');

    await expect(page.getByRole('heading', { exact: true, name: 'Mattermost' })).toBeVisible();
    await expect(page.getByTestId('channel-mapping-list')).toContainText('Ash House');

    await page.getByLabel('Kind').selectOption('safeguarding');
    await page.getByLabel('Channel ID').fill('safeguarding-channel-1');
    await page.getByLabel('Channel name').fill('Safeguarding team');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('channel-mapping-list')).toContainText('Safeguarding team');

    await page.getByTestId('issue-link-code').click();
    await expect(page.getByTestId('link-code-result')).toContainText('/link A1B2C3D4E5F6');
  });

  test('has no axe violations on /comms/mattermost', async ({ page }) => {
    await page.goto('/comms/mattermost');
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function mockMattermostWrites(page: Page): Promise<void> {
  await page.route('**/api/comms/mattermost/channels', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    const body = route.request().postDataJSON() as {
      readonly channelId: string;
      readonly channelName: string;
      readonly kind: string;
    };
    await route.fulfill({
      contentType: 'application/json',
      json: {
        ...body,
        id: '13131313-1313-4313-8313-131313131313',
        updatedAt: '2026-05-18T07:00:00.000Z',
      },
      status: 201,
    });
  });

  await page.route('**/api/comms/mattermost/link-codes', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    await route.fulfill({
      contentType: 'application/json',
      json: {
        code: 'A1B2C3D4E5F6',
        expiresAt: '2026-05-18T07:10:00.000Z',
        slashCommand: '/link A1B2C3D4E5F6',
      },
      status: 201,
    });
  });
}
