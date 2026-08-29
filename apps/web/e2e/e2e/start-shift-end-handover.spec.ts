import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const shiftId = '33333333-3333-4333-8333-333333333333';

test.describe('start shift-end handover', () => {
  test('renders the schema-driven form and starts a HandoverWorkflow', async ({ page }) => {
    await mockCreateHandover(page);

    await page.goto('/handovers');
    await expect(page.getByRole('heading', { name: 'Start shift-end handover' })).toBeVisible();
    await expect(page.getByText(/Correlation ID/)).toBeVisible();

    await page.getByLabel('Transcript object key').fill('handovers/2026-05-17/shift-a.txt');
    await page.locator('[data-field="shiftId"] input').fill(shiftId);
    await page
      .getByLabel('Free-text handover')
      .fill('Night shift was calm. Jamie needs a morning check-in; medication times unchanged.');

    await page.getByRole('button', { name: 'Start handover workflow' }).click();

    await expect(page.getByText(/is processing/)).toBeVisible();
  });

  test('has no axe violations on /handovers', async ({ page }) => {
    await page.goto('/handovers');
    await expect(page.locator('main')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function mockCreateHandover(page: Page): Promise<void> {
  await page.route('**/api/handovers', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();

    const payload = route.request().postDataJSON() as {
      readonly free_text?: unknown;
      readonly shift_id?: unknown;
      readonly transcript_object_key?: unknown;
    };
    expect(payload.shift_id).toBe(shiftId);
    expect(payload.transcript_object_key).toBe('handovers/2026-05-17/shift-a.txt');
    expect(payload.free_text).toContain('Jamie');

    await route.fulfill({
      contentType: 'application/json',
      json: {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        status: 'processing',
        workflowId: 'handover-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
      status: 202,
    });
  });
}
