import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.describe('draft email for review', () => {
  test('starts an EmailDraftWorkflow and never claims it was sent', async ({ page }) => {
    await mockCreateEmailDraft(page);

    await page.goto('/comms/email/new');
    await expect(page.getByRole('heading', { name: 'Draft an email' })).toBeVisible();
    await expect(page.getByText(/Correlation ID/)).toBeVisible();
    await expect(page.getByText(/CareOS never sends email automatically/)).toBeVisible();

    await page.getByLabel('Source kind').selectOption('handover');
    await page
      .getByLabel('Context summary')
      .fill('Calm evening shift; routine update for the duty manager. No incidents to report.');
    await page.getByLabel('Recipient email').fill('manager@example.com');
    await page.getByLabel('Recipient role').fill('manager');
    await page
      .getByLabel('Drafting instructions')
      .fill('Inform the duty manager that the evening shift was calm with no concerns.');

    await page.getByRole('button', { name: 'Draft email for review' }).click();

    const banner = page.getByText(/is processing/);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('saved as a draft for review');
    await expect(banner).toContainText('nothing has been sent');
  });

  test('has no axe violations on /comms/email/new', async ({ page }) => {
    await page.goto('/comms/email/new');
    await expect(page.locator('main')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

async function mockCreateEmailDraft(page: Page): Promise<void> {
  await page.route('**/api/comms/email/draft', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();

    const payload = route.request().postDataJSON() as {
      readonly source?: { readonly kind?: unknown; readonly summary?: unknown };
      readonly recipient?: { readonly email?: unknown };
      readonly instructions?: unknown;
    };
    expect(payload.source?.kind).toBe('handover');
    expect(payload.source?.summary).toContain('Calm evening');
    expect(payload.recipient?.email).toBe('manager@example.com');
    expect(payload.instructions).toContain('duty manager');

    await route.fulfill({
      contentType: 'application/json',
      json: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'processing',
        workflowId: 'email-draft-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      status: 202,
    });
  });
}
