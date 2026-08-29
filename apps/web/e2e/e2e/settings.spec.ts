import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('operations settings', () => {
  test('updates retention policies without exposing a destructive sweep command', async ({
    page,
  }) => {
    await page.route('**/api/retention/policies', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toEqual({
        action: 'object_delete',
        enabled: true,
        record_type: 'attachment',
        retention_days: 730,
      });
      await route.fulfill({
        body: JSON.stringify({
          action: 'object_delete',
          createdAt: '2026-07-01T09:00:00.000Z',
          enabled: true,
          id: '72727272-7272-4272-8272-727272727272',
          recordType: 'attachment',
          retentionDays: 730,
          updatedAt: '2026-07-15T09:00:00.000Z',
        }),
        contentType: 'application/json',
        status: 200,
      });
    });

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByTestId('retention-run-list')).toContainText(/affected 3/i);
    await page.getByLabel('Record type').selectOption('attachment');
    await page.getByLabel('Retention days').fill('730');
    await page.getByLabel('Action').selectOption('object_delete');
    await page.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByRole('status')).toContainText('Attachment policy saved');
    await expect(page.getByTestId('retention-policy-list')).toContainText('730 days');
    await expect(page.getByRole('button', { name: /sweep/i })).toHaveCount(0);
  });

  test('has no axe violations', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
