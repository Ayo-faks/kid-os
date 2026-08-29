import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('dashboard Phase 2 entry points', () => {
  test('surfaces quick actions, rota gap badge, and pending approvals', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // Home-scoped summary counts come from the residents and incidents APIs.
    await expect(
      page.getByText('Residents', { exact: true }).locator('..').getByText('1', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByText('Open incidents', { exact: true })
        .locator('..')
        .getByText('1', { exact: true }),
    ).toBeVisible();

    // Quick actions link to each Phase 2 surface.
    await expect(page.getByRole('link', { name: /Start handover/ })).toHaveAttribute(
      'href',
      '/handovers',
    );
    await expect(page.getByRole('link', { name: /Draft email/ })).toHaveAttribute(
      'href',
      '/comms/email/new',
    );
    await expect(page.getByRole('link', { name: /Review approvals/ })).toHaveAttribute(
      'href',
      '/approvals',
    );
    await expect(page.getByRole('link', { name: /View rota/ })).toHaveAttribute('href', '/rota');

    // Today's rota card with gap badge (fixture: 1 shift, min 2, 1 assigned -> 1 gap).
    await expect(page.getByRole('heading', { name: /Next shift/ })).toBeVisible();
    await expect(page.getByTestId('rota-gap-badge')).toHaveText('1 gap needs filling');
    await expect(page.getByRole('link', { name: 'Open rota editor' })).toHaveAttribute(
      'href',
      '/rota',
    );

    // Approvals summary reflects real fixture count.
    await expect(page.getByText('Approvals pending')).toBeVisible();
    await expect(
      page.locator('section', { hasText: 'Approvals pending' }).getByText('4', { exact: true }),
    ).toBeVisible();

    // The active viewport exposes either the desktop sidebar or mobile disclosure.
    const isMobile = (page.viewportSize()?.width ?? 1440) < 1024;
    if (isMobile) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    const nav = page.getByRole('navigation', {
      name: isMobile ? 'Mobile navigation' : 'Primary navigation',
    });
    await expect(nav.getByRole('link', { name: 'Handovers' })).toHaveAttribute(
      'href',
      '/handovers',
    );
    await expect(nav.getByRole('link', { name: 'Communications' })).toHaveAttribute(
      'href',
      '/comms/email/new',
    );
    await expect(nav.getByRole('link', { name: 'Rota' })).toHaveAttribute('href', '/rota');
    await expect(nav.getByRole('link', { name: 'Approvals' })).toHaveAttribute(
      'href',
      '/approvals',
    );
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    await expect(nav.locator('a[href="#"]')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Notifications' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
  });

  test('exposes usable navigation on mobile', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Residents' })).toHaveAttribute(
      'href',
      '/residents',
    );
    await expect(nav.getByRole('link', { name: 'Incidents' })).toHaveAttribute(
      'href',
      '/incidents',
    );
    await expect(nav.locator('a[href="#"]')).toHaveCount(0);
  });

  test('has no axe violations on /', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
