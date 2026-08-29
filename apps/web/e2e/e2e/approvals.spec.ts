import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const approvalAId = '77777777-7777-4777-8777-777777777777';
const approvalBId = '88888888-8888-4888-8888-888888888888';
const routineIncidentApprovalId = '89898989-8989-4989-8989-898989898989';
const secondSignOffApprovalId = '90909090-9090-4090-8090-909090909090';

test.describe('manager approvals queue', () => {
  test('approves and rejects sensitive email-draft approvals', async ({ page }) => {
    await mockApprovalDecisions(page);

    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByText('4 pending')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sensitive family update' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Safeguarding follow-up' })).toBeVisible();
    await expect(page.getByTestId('approval-signatures-progress').first()).toHaveText(
      '0 of 2 sign-offs',
    );

    await page.getByRole('button', { name: 'Approve Sensitive family update' }).click();
    await expect(page.getByText('4 pending')).toBeVisible();
    await expect(page.getByTestId('approval-signatures-progress').first()).toHaveText(
      '1 of 2 sign-offs',
    );

    await page.getByRole('button', { name: 'Reject Safeguarding follow-up' }).click();
    await expect(page.getByText('3 pending')).toBeVisible();
    await expect(page.getByText('rejected')).toBeVisible();

    await page.getByRole('button', { name: 'Approve Routine incident review' }).click();
    await expect(page.getByText('2 pending')).toBeVisible();
    await expect(
      page
        .locator('li', { has: page.getByRole('heading', { name: 'Routine incident review' }) })
        .getByText('approved'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Approve Safeguarding second sign-off' }).click();
    await expect(page.getByText('1 pending')).toBeVisible();
    await expect(
      page
        .locator('li', {
          has: page.getByRole('heading', { name: 'Safeguarding second sign-off' }),
        })
        .getByText('approved'),
    ).toBeVisible();
  });

  test('has no axe violations on /approvals', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page.locator('main')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function mockApprovalDecisions(page: Page): Promise<void> {
  await page.route('**/api/approvals/*/approve', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    const approvalId = new URL(route.request().url()).pathname.split('/').at(-2);
    expect([approvalAId, routineIncidentApprovalId, secondSignOffApprovalId]).toContain(approvalId);

    await route.fulfill({
      contentType: 'application/json',
      json: { accepted: true, workflowId: `approval-${approvalId}` },
      status: 202,
    });
  });

  await page.route('**/api/approvals/*/reject', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    expect(route.request().url()).toContain(approvalBId);

    await route.fulfill({
      contentType: 'application/json',
      json: { accepted: true, workflowId: `approval-${approvalBId}` },
      status: 202,
    });
  });
}
