import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const residentId = '22222222-2222-4222-8222-222222222222';

test.describe('create incident from prompt', () => {
  test('drafts a schema-driven incident and saves it', async ({ page }) => {
    await mockIncidentDraft(page);
    await mockCreateIncident(page);

    await page.goto('/incidents/new');
    await expect(page.getByText(/Correlation ID/)).toBeVisible();

    await page
      .getByLabel('Incident prompt')
      .fill(
        'Jamie Connor became distressed in the lounge after a cancelled family call. Staff used a calm voice, offered space, and no injuries were reported.',
      );
    await page.getByRole('button', { name: 'Draft from prompt' }).click();

    await expect(page.getByText('Draft confidence 86%.')).toBeVisible();
    await expect(page.getByLabel('Resident')).toHaveValue(residentId);
    await expect(page.getByLabel('Where did it happen?')).toHaveValue('Lounge');
    await expect(page.getByLabel('What happened?')).toHaveValue(/cancelled family call/);
    await expect(
      page.locator('[data-field="triggers"]').getByText('cancelled family call'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved as incident/)).toBeVisible();
  });

  for (const route of ['/', '/incidents/new', `/residents/${residentId}`, '/approvals'] as const) {
    test(`has no axe violations on ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

async function mockIncidentDraft(page: Page): Promise<void> {
  await page.route('**/api/incidents/draft-from-text', async (route) => {
    expect(route.request().method()).toBe('POST');
    const payload = route.request().postDataJSON() as {
      readonly free_text?: unknown;
      readonly template_id?: unknown;
    };
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    expect(payload).toMatchObject({ correlation_id: expect.any(String), resident_id: residentId });
    expect(payload.free_text).toContain('Jamie Connor');
    expect(payload.template_id).toBe('incident.behavioural');

    await route.fulfill({
      contentType: 'application/json',
      json: {
        confidence: 0.86,
        form_data: {
          behaviourType: 'verbal_aggression',
          location: 'Lounge',
          occurredAt: '2026-05-17T08:45:00.000Z',
          outcomeForResident:
            'Jamie settled in the quiet room and rejoined the group after a check-in.',
          physicalInterventionUsed: false,
          residentId,
          responseTaken: 'Staff used a calm voice, offered space, and completed a wellbeing check.',
          safeguardingConcern: false,
          summary:
            'Jamie Connor became distressed in the lounge after a cancelled family call. Staff supported Jamie without physical intervention and no injuries were reported.',
          triggers: ['cancelled family call'],
          witnesses: ['night support worker'],
        },
        missing_mandatory: [],
      },
      status: 200,
    });
  });
}

async function mockCreateIncident(page: Page): Promise<void> {
  await page.route('**/api/incidents', async (route) => {
    if (route.request().url().endsWith('/draft-from-text')) {
      await route.fallback();
      return;
    }

    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-careos-correlation-id']).toBeTruthy();
    const payload = route.request().postDataJSON() as {
      readonly formTemplate?: { readonly templateId?: unknown; readonly version?: unknown };
      readonly residentId?: unknown;
    };
    expect(payload.residentId).toBe(residentId);
    expect(payload.formTemplate?.templateId).toBe('incident.behavioural');
    expect(payload.formTemplate?.version).toBe('v1');

    await route.fulfill({
      contentType: 'application/json',
      json: {
        id: '55555555-5555-4555-8555-555555555555',
        status: 'draft',
        workflowId: 'incident-report-55555555-5555-4555-8555-555555555555',
      },
      status: 202,
    });
  });
}
