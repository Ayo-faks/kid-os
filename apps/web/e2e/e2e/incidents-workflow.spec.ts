import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const incidentId = '44444444-4444-4444-8444-444444444444';
const approvedIncidentId = '48484848-4848-4848-8848-484848484848';
const exportedIncidentId = '45454545-4545-4545-8545-454545454545';
const bundleId = '46464646-4646-4646-8646-464646464646';
const residentId = '22222222-2222-4222-8222-222222222222';

test.describe('incident safeguarding workflow UI', () => {
  test('lists incidents and shows role-aware safeguarding detail', async ({ page }) => {
    await page.goto('/incidents');
    await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
    await page.locator(`a[href="/incidents/${incidentId}"]`).click();

    await expect(page).toHaveURL(`/incidents/${incidentId}`);
    await expect(page.getByRole('heading', { name: 'Jamie Connor' })).toBeVisible();
    await expect(page.getByText('This incident requires distinct manager')).toBeVisible();
    await expect(page.getByTestId('incident-immediate-risk')).toContainText(
      'CareOS has not contacted any external agency',
    );
    await expect(page.getByTestId('incident-approval-progress')).toHaveText('1 of 2');
    await expect(page.getByText('Required: Manager + Safeguarding lead')).toBeVisible();
    await expect(page.getByText('Still needed: Safeguarding lead')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export PDF' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create bundle' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open approval queue' })).toHaveAttribute(
      'href',
      '/approvals',
    );
  });

  test('shows timeline evidence and downloads a ready serious bundle', async ({ page }) => {
    await page.route(`**/api/export-bundles/${bundleId}/download`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        json: { expiresAt: '2026-07-10T12:05:00.000Z', url: `/incidents/${exportedIncidentId}` },
        status: 200,
      });
    });

    await page.goto(`/incidents/${exportedIncidentId}`);
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(page.getByText('Approved safeguarding incident exported to PDF.')).toBeVisible();
    await expect(page.getByTestId('incident-bundle-status')).toHaveText('Bundle ready');
    const downloadRequest = page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        request.url().endsWith(`/api/export-bundles/${bundleId}/download`),
    );
    await page.getByRole('button', { name: 'Download bundle' }).click();
    await downloadRequest;
  });

  test('requests a serious bundle only after incident approval', async ({ page }) => {
    await page.route('**/api/export-bundles', async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({ incident_id: approvedIncidentId });
      await route.fulfill({
        contentType: 'application/json',
        json: {
          id: '49494949-4949-4949-8949-494949494949',
          status: 'pending',
          workflowId: 'serious-incident-export-49494949-4949-4949-8949-494949494949',
        },
        status: 202,
      });
    });

    await page.goto(`/incidents/${approvedIncidentId}`);
    await page.getByRole('button', { name: 'Create bundle' }).click();
    await expect(page.getByTestId('incident-bundle-status')).toHaveText('Bundle pending');
    await expect(page.getByRole('status')).toContainText('Serious-incident bundle requested');
  });

  test('selects the safeguarding template and sends create then submit', async ({ page }) => {
    let createBody: Record<string, unknown> | undefined;
    let submitted = false;
    await page.route('**/api/incidents', async (route) => {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        contentType: 'application/json',
        json: { id: incidentId, status: 'draft', workflowId: `incident-${incidentId}` },
        status: 202,
      });
    });
    await page.route(`**/api/incidents/${incidentId}/submit`, async (route) => {
      submitted = true;
      await route.fulfill({
        contentType: 'application/json',
        json: { accepted: true, workflowId: `incident-${incidentId}` },
        status: 202,
      });
    });
    await page.route(`**/api/incidents/${incidentId}`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        json: { approval: { id: incidentId }, id: incidentId, status: 'awaiting_approval' },
        status: 200,
      });
    });

    await page.goto('/incidents/new');
    await page.getByLabel('Incident template').selectOption('incident.safeguarding@v1');
    await expect(page.getByText('Safeguarding incidents require distinct')).toBeVisible();

    await page.getByLabel('Resident', { exact: true }).selectOption(residentId);
    await page.getByLabel('When did it happen?').fill('2026-07-10T10:00');
    await page.getByLabel('When was it discovered?').fill('2026-07-10T10:05');
    await page.getByLabel('Category of concern').selectOption('neglect');
    await page
      .getByLabel('Factual summary')
      .fill('A factual safeguarding concern that requires human review and sign-off.');
    await page.locator('[data-field="isChildAtImmediateRisk"] input[type="checkbox"]').check();
    await page.getByLabel('Immediate actions taken').fill('The child was moved to a safe space.');
    await page.locator('[data-field="reportedToDsl"] input[type="checkbox"]').check();
    await page.getByLabel('When was DSL informed?').fill('2026-07-10T10:10');
    await page.getByRole('button', { name: 'Submit for review' }).click();

    await expect(page).toHaveURL(`/incidents/${incidentId}`);
    expect(submitted).toBe(true);
    expect(createBody).toMatchObject({
      formTemplate: { templateId: 'incident.safeguarding', version: 'v1' },
      residentId,
    });
  });

  test('has no axe violations on incident list and detail', async ({ page }) => {
    test.setTimeout(120_000);
    for (const path of [
      '/incidents',
      `/incidents/${incidentId}`,
      `/incidents/${exportedIncidentId}`,
    ]) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, path).toEqual([]);
    }
  });
});
