import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('incident insights', () => {
  test('shows trends, guarded projection, and transparent review prompts', async ({ page }) => {
    await page.goto('/reports');

    await expect(page.getByRole('heading', { name: 'Incident insights' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText('13', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('69%', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Monthly trend' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Monthly incident totals/ })).toBeVisible();

    const monthlyTable = page.getByRole('table', { name: 'Monthly incident counts' });
    await expect(monthlyTable.getByRole('row', { name: /2026-04 0 0 0/ })).toBeVisible();
    await expect(
      monthlyTable.getByRole('row', { name: /2026-07 \(month to date\)/ }),
    ).toBeVisible();
    await expect(page.getByText('4.7', { exact: true })).toBeVisible();
    await expect(page.getByText(/prior three closed months/i)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Review incident approvals' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Review export coverage' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Review staffing and care-plan patterns' }),
    ).toBeVisible();
  });

  test('propagates an inclusive date range to CSV download links', async ({ page }) => {
    await page.goto('/reports?from=2026-05-01&through=2026-06-30');

    await expect(page.getByLabel('From')).toHaveValue('2026-05-01');
    await expect(page.getByLabel('Through')).toHaveValue('2026-06-30');
    const monthCsv = page
      .locator('section', { has: page.getByRole('heading', { name: 'Monthly trend' }) })
      .getByRole('link', { name: 'Download CSV' });
    await expect(monthCsv).toHaveAttribute(
      'href',
      /groupBy=month&from=2026-05-01T00%3A00%3A00\.000Z&to=2026-07-01T00%3A00%3A00\.000Z/,
    );
  });

  test('has no axe violations', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Incident insights' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
