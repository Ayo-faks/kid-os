import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('Care Assistant streaming contract', () => {
  test('shows an accessible progress state until the first token arrives', async ({ page }) => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route('**/api/assistant/messages', async (route) => {
      await responseGate;
      await route.fulfill({
        body:
          'event: token\n' +
          'data: {"type":"token","content":"Hello. How can I help?"}\n\n' +
          'event: done\n' +
          'data: {"type":"done","tokens":6}\n\n',
        contentType: 'text/event-stream; charset=utf-8',
        status: 200,
      });
    });

    await page.goto('/');
    await page.getByLabel('Message Care Assistant').fill('Hi');
    await page.getByRole('button', { name: 'Send' }).click();

    const progress = page.getByRole('status').filter({ hasText: 'Care Assistant is thinking' });
    await expect(progress).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('[aria-label="Care Assistant"]').analyze();
    expect(axe.violations).toEqual([]);

    releaseResponse?.();
    await expect(page.getByText('Hello. How can I help?')).toBeVisible();
    await expect(progress).toHaveCount(0);
  });

  test('sends all quick actions with their stable action IDs', async ({ page }) => {
    const payloads: unknown[] = [];
    await page.route('**/api/assistant/messages', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        body:
          'event: token\n' +
          `data: {"type":"token","content":"Draft ${payloads.length} ready for staff review."}\n\n` +
          'event: done\n' +
          'data: {"type":"done","tokens":7}\n\n',
        contentType: 'text/event-stream; charset=utf-8',
        status: 200,
      });
    });

    await page.goto('/');
    const input = page.getByLabel('Message Care Assistant');
    const cases = [
      ['Create incident report', 'create_incident', 'Jamie became distressed after lunch.'],
      [
        'Notify safeguarding lead',
        'notify_safeguarding',
        'A staff member observed an immediate-risk concern.',
      ],
      [
        'Update behaviour log',
        'update_behaviour_log',
        'Jamie joined the activity calmly and spoke with peers.',
      ],
    ] as const;

    for (const [label, quickActionId, message] of cases) {
      await input.fill(message);
      await page.getByRole('button', { name: label }).click();
      await expect(
        page.getByText(`Draft ${payloads.length} ready for staff review.`),
      ).toBeVisible();
      expect(payloads.at(-1)).toEqual({ message, quickActionId });
    }
  });

  test('blocks blank input and creates only one stream for same-tick submits', async ({ page }) => {
    let attempts = 0;
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route('**/api/assistant/messages', async (route) => {
      attempts += 1;
      await requestGate;
      await route.fulfill({
        body:
          'event: token\n' +
          'data: {"type":"token","content":"One response."}\n\n' +
          'event: done\n' +
          'data: {"type":"done","tokens":2}\n\n',
        contentType: 'text/event-stream; charset=utf-8',
        status: 200,
      });
    });

    await page.goto('/');
    const input = page.getByLabel('Message Care Assistant');
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await input.fill('   ');
    await expect(send).toBeDisabled();
    await input.fill('Summarise what staff should record.');

    await page.locator('form').evaluate((form) => {
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    await expect.poll(() => attempts).toBe(1);
    releaseRequest?.();
    await expect(page.getByText('One response.')).toBeVisible();
  });

  test('shows a retryable unavailable state without a fake assistant reply', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/assistant/messages', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          body:
            'event: error\n' +
            'data: {"type":"error","message":"Care Assistant is temporarily unavailable. Please try again."}\n\n',
          contentType: 'text/event-stream; charset=utf-8',
          status: 200,
        });
        return;
      }

      await route.fulfill({
        body:
          'event: token\n' +
          'data: {"type":"token","content":"Record factual observations and the staff response."}\n\n' +
          'event: done\n' +
          'data: {"type":"done","tokens":8}\n\n',
        contentType: 'text/event-stream; charset=utf-8',
        status: 200,
      });
    });

    await page.goto('/');
    await page
      .getByLabel('Message Care Assistant')
      .fill('What information should I record after an incident?');
    await page.getByRole('button', { name: 'Send' }).click();

    const unavailableAlert = page
      .getByRole('alert')
      .filter({ hasText: 'Care Assistant is temporarily unavailable' });
    await expect(unavailableAlert).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Care Assistant' })).toHaveCount(0);
    await expect(page.getByText(/stub reply/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Retry response' }).click();

    await expect(
      page.getByText('Record factual observations and the staff response.'),
    ).toBeVisible();
    await expect(unavailableAlert).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Care Assistant' })).toHaveCount(0);
    expect(attempts).toBe(2);
  });
});
