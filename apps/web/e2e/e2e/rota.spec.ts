import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const shiftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test.describe('rota assist', () => {
  test('runs analyze and publishes', async ({ page }) => {
    await mockRotaApis(page);

    await page.goto('/rota');
    await expect(page.getByRole('heading', { name: 'Rota assist' })).toBeVisible();
    await expect(page.getByText('Minimum support workers')).toBeVisible();

    await page.getByRole('button', { name: 'Analyze' }).click();
    await expect(page.getByText('Shift needs 2 support_worker on duty')).toBeVisible();
    await expect(page.getByTestId('rota-narration')).toContainText('Coverage gap detected');

    await page.getByRole('button', { name: 'Publish rota' }).click();
    await expect(page.getByText(/Rota published/)).toBeVisible();
  });

  test('has no axe violations on /rota', async ({ page }) => {
    await page.goto('/rota', { waitUntil: 'networkidle' });
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function mockRotaApis(page: Page): Promise<void> {
  await page.route('**/api/rota/analyze', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    await route.fulfill({
      contentType: 'application/json',
      json: {
        correlationId: 'corr-rota',
        gaps: [
          {
            detail: 'Shift needs 2 support_worker on duty; currently 1.',
            kind: 'min_staffing',
            ruleId: 'rule-1',
            ruleName: 'Minimum support workers',
            severity: 'high',
            shiftId,
          },
        ],
        narration: 'Coverage gap detected on the morning shift.',
        periodEnd: '2026-05-18T15:00:00.000Z',
        periodStart: '2026-05-18T07:00:00.000Z',
        proposals: [
          {
            addUserIds: [userId],
            reason: 'covers minimum',
            removeUserIds: [],
            resolvedGapKinds: ['min_staffing'],
            shiftId,
          },
        ],
        shifts: [
          {
            assignedUserIds: [],
            endsAt: '2026-05-18T15:00:00.000Z',
            id: shiftId,
            minHeadcount: 2,
            requiredRole: 'support_worker',
            startsAt: '2026-05-18T07:00:00.000Z',
          },
        ],
      },
      status: 200,
    });
  });

  await page.route('**/api/rota/publish', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    await route.fulfill({
      contentType: 'application/json',
      json: {
        publicationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        status: 'processing',
        workflowId: 'rota-publish-1',
      },
      status: 202,
    });
  });
}
