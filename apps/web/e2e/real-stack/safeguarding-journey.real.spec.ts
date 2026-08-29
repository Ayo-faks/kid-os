import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const ASH_HOME_ID = '20000000-0000-4000-8000-00000000000a';
const JAMIE_RESIDENT_ID = '40000000-0000-4000-8000-000000000001';
const PASSWORD = 'careos-dev-password';

interface IncidentDetail {
  readonly approval: {
    readonly id: string;
    readonly signaturesRecorded: number;
    readonly signaturesRequired: number;
    readonly missingRoles: readonly string[];
    readonly status: string;
  } | null;
  readonly exportBundle: {
    readonly status: 'pending' | 'building' | 'ready' | 'failed';
  } | null;
  readonly id: string;
  readonly status: string;
}

interface ApprovalItem {
  readonly currentUserHasSigned: boolean;
  readonly id: string;
  readonly missingRoles: readonly string[];
  readonly signaturesRecorded: number;
  readonly signaturesRequired: number;
  readonly subjectId: string;
}

interface ApprovalQueue {
  readonly items: readonly ApprovalItem[];
}

test.describe('REL-030..033 real-stack safeguarding and approval journey', () => {
  test('enforces routine, dual-role, duplicate, veto, and export gates with real Keycloak and Temporal', async ({
    browser,
  }) => {
    const runId = Date.now().toString(36);
    const support = await login(browser, 'ash.support@careos.local', '/incidents/new');
    const manager = await login(browser, 'manager@careos.local', '/approvals');
    const safeguarding = await login(browser, 'safeguarding.lead@careos.local', '/approvals');

    try {
      const dualSummary = `REL-031 dual approval ${runId}: Jamie disclosed a safeguarding concern requiring two distinct reviewers.`;
      const routineSummary = `REL-032 routine approval ${runId}: Jamie became distressed during a planned transition.`;
      const vetoSummary = `REL-031 veto ${runId}: Jamie reported a safeguarding concern requiring rejection evidence.`;

      const dualIncidentId = await createSafeguardingIncident(support.page, dualSummary);
      const routineIncidentId = await createRoutineIncident(support.page, routineSummary);
      const vetoIncidentId = await createSafeguardingIncident(support.page, vetoSummary);

      await assertPreApprovalExportGate(support.page, dualIncidentId);

      const dualApproval = await waitForApproval(manager.page, dualIncidentId);
      await manager.page.reload();
      const dualCard = approvalCard(manager.page, dualSummary);
      await expect(dualCard).toBeVisible();
      await expect(dualCard.getByTestId('approval-signatures-progress')).toHaveText(
        '0 of 2 sign-offs',
      );
      await dualCard.getByRole('button', { name: 'Approve Safeguarding incident review' }).click();

      await expect
        .poll(async () => (await findApproval(manager.page, dualIncidentId))?.signaturesRecorded, {
          timeout: 60_000,
        })
        .toBe(1);
      await manager.page.reload();
      const signedManagerCard = approvalCard(manager.page, dualSummary);
      await expect(signedManagerCard.getByTestId('approval-signatures-progress')).toHaveText(
        '1 of 2 sign-offs',
      );
      await expect(signedManagerCard.getByText('Your decision is recorded.')).toBeVisible();
      await expect(
        signedManagerCard.getByRole('button', { name: 'Approve Safeguarding incident review' }),
      ).toBeDisabled();

      const duplicate = await manager.page.request.post(
        absoluteUrl(manager.page, `/api/approvals/${dualApproval.id}/approve`),
        {
          data: {},
          headers: mutationHeaders(`duplicate-${runId}`),
        },
      );
      expect(duplicate.status()).toBe(202);
      await expect
        .poll(async () => (await findApproval(manager.page, dualIncidentId))?.signaturesRecorded, {
          timeout: 30_000,
        })
        .toBe(1);

      const routineCard = approvalCard(manager.page, routineSummary);
      await expect(routineCard.getByTestId('approval-signatures-progress')).toHaveText(
        '0 of 1 sign-off',
      );
      await routineCard.getByRole('button', { name: 'Approve Incident review' }).click();
      await waitForIncidentStatus(manager.page, routineIncidentId, 'approved');

      const vetoCard = approvalCard(manager.page, vetoSummary);
      await vetoCard.getByRole('button', { name: 'Reject Safeguarding incident review' }).click();
      await waitForIncidentStatus(manager.page, vetoIncidentId, 'rejected');
      await manager.page.goto(`/incidents/${vetoIncidentId}`);
      await expect(manager.page.getByText('rejected', { exact: true }).first()).toBeVisible();
      await expect(manager.page.getByRole('button', { name: 'Export PDF' })).toHaveCount(0);
      await expect(manager.page.getByRole('button', { name: 'Create bundle' })).toHaveCount(0);

      await safeguarding.page.reload();
      const safeguardingCard = approvalCard(safeguarding.page, dualSummary);
      await expect(safeguardingCard.getByTestId('approval-signatures-progress')).toHaveText(
        '1 of 2 sign-offs',
      );
      await expect(safeguardingCard.getByText('Still needed').locator('..')).toContainText(
        'Safeguarding lead',
      );
      await safeguardingCard
        .getByRole('button', { name: 'Approve Safeguarding incident review' })
        .click();

      await waitForIncidentStatus(safeguarding.page, dualIncidentId, 'approved');
      await expect
        .poll(
          async () =>
            (
              await requestJson<IncidentDetail>(
                safeguarding.page,
                `/api/incidents/${dualIncidentId}`,
              )
            ).exportBundle?.status,
          { timeout: 60_000 },
        )
        .toBe('ready');
      await safeguarding.page.goto(`/incidents/${dualIncidentId}`);
      await expect(safeguarding.page.getByText('approved', { exact: true }).first()).toBeVisible();
      await expect(safeguarding.page.getByRole('button', { name: 'Export PDF' })).toBeVisible();
      await expect(safeguarding.page.getByTestId('incident-bundle-status')).toHaveText(
        'Bundle ready',
      );
      await expect(
        safeguarding.page.getByRole('button', { name: 'Download bundle' }),
      ).toBeVisible();
      const axe = await new AxeBuilder({ page: safeguarding.page }).analyze();
      expect(axe.violations).toEqual([]);
    } finally {
      await Promise.all([
        support.context.close(),
        manager.context.close(),
        safeguarding.context.close(),
      ]);
    }
  });
});

async function login(
  browser: Browser,
  username: string,
  targetPath: string,
): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const expectedOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost').origin;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(targetPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (new URL(page.url()).pathname.startsWith('/api/auth/signin')) {
        await page.getByRole('button', { name: /Keycloak/i }).click();
        await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
      }
      if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill(username);
        await page.locator('#password').fill(PASSWORD);
        await page.locator('#kc-login').click();
      }
      await page.waitForURL((url) => url.origin === expectedOrigin && url.pathname === targetPath, {
        timeout: 60_000,
      });
      break;
    } catch (error) {
      const signinError = page.getByText('Try signing in with a different account.');
      if (attempt === 0 && (await signinError.isVisible())) {
        continue;
      }
      throw error;
    }
  }

  expect(new URL(page.url()).origin).toBe(expectedOrigin);
  await expect(page.locator('main')).toBeVisible();
  return { context, page };
}

async function createSafeguardingIncident(page: Page, summary: string): Promise<string> {
  await page.goto('/incidents/new');
  await page.getByLabel('Incident template').selectOption('incident.safeguarding@v1');
  await expect(
    page.getByLabel('Resident', { exact: true }).locator(`option[value="${JAMIE_RESIDENT_ID}"]`),
  ).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.getByLabel('Resident', { exact: true }).selectOption(JAMIE_RESIDENT_ID);
  await page.getByLabel('When did it happen?').fill(localDateTime(15));
  await page.getByLabel('When was it discovered?').fill(localDateTime(10));
  await page.getByLabel('Category of concern').selectOption('neglect');
  await page.getByLabel('Factual summary').fill(summary);
  await page.locator('[data-field="isChildAtImmediateRisk"] input[type="checkbox"]').check();
  await page
    .getByLabel('Immediate actions taken')
    .fill('Jamie was moved to a safe space and the on-call safeguarding process was started.');
  await page.locator('[data-field="reportedToDsl"] input[type="checkbox"]').check();
  await page.getByLabel('When was DSL informed?').fill(localDateTime(5));
  return submitIncident(page);
}

async function createRoutineIncident(page: Page, summary: string): Promise<string> {
  await page.goto('/incidents/new');
  await page.getByLabel('Incident template').selectOption('incident.behavioural@v1');
  await expect(
    page.getByLabel('Resident', { exact: true }).locator(`option[value="${JAMIE_RESIDENT_ID}"]`),
  ).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.getByLabel('Resident', { exact: true }).selectOption(JAMIE_RESIDENT_ID);
  await page.getByLabel('When did it happen?').fill(localDateTime(20));
  await page.getByLabel('Where did it happen?').fill('Ash House lounge');
  await page.getByLabel('Behaviour type').selectOption('verbal_aggression');
  await page.getByLabel('What happened?').fill(summary);
  const triggers = page.locator('[data-field="triggers"] input');
  await triggers.fill('planned transition');
  await triggers.press('Enter');
  await page
    .getByLabel('How did staff respond?')
    .fill('Staff used a calm voice, offered space, and completed a wellbeing check.');
  await page
    .getByLabel('Outcome for the young person')
    .fill('Jamie settled and rejoined the planned activity after a check-in.');
  return submitIncident(page);
}

async function submitIncident(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/i, { timeout: 90_000 });
  const incidentId = new URL(page.url()).pathname.split('/').at(-1);
  if (incidentId === undefined) throw new Error('Incident id was missing after submission.');
  await expect(page.getByTestId('incident-approval-progress')).toBeVisible();
  return incidentId;
}

async function assertPreApprovalExportGate(page: Page, incidentId: string): Promise<void> {
  await page.goto(`/incidents/${incidentId}`);
  await expect(page.getByTestId('incident-approval-progress')).toHaveText('0 of 2');
  await expect(page.getByRole('button', { name: 'Export PDF' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create bundle' })).toHaveCount(0);
}

function approvalCard(page: Page, summary: string) {
  return page.locator('li').filter({ hasText: summary });
}

async function waitForApproval(page: Page, incidentId: string): Promise<ApprovalItem> {
  let approval: ApprovalItem | undefined;
  await expect
    .poll(
      async () => {
        approval = await findApproval(page, incidentId);
        return approval?.id;
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();
  if (approval === undefined) throw new Error(`Approval for incident ${incidentId} was missing.`);
  return approval;
}

async function findApproval(page: Page, incidentId: string): Promise<ApprovalItem | undefined> {
  const queue = await requestJson<ApprovalQueue>(page, '/api/approvals');
  return queue.items.find((item) => item.subjectId === incidentId);
}

async function waitForIncidentStatus(
  page: Page,
  incidentId: string,
  expectedStatus: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await requestJson<IncidentDetail>(page, `/api/incidents/${incidentId}`)).status,
      {
        timeout: 60_000,
      },
    )
    .toBe(expectedStatus);
}

async function requestJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(absoluteUrl(page, path), {
    headers: {
      'x-careos-correlation-id': `phase4-real-${Date.now().toString(36)}`,
      'x-careos-home-id': ASH_HOME_ID,
    },
  });
  expect(response.status(), path).toBe(200);
  return response.json() as Promise<T>;
}

function mutationHeaders(id: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': `phase4-real-${id}`,
    'x-careos-correlation-id': `phase4-real-${id}`,
    'x-careos-home-id': ASH_HOME_ID,
  };
}

function absoluteUrl(page: Page, path: string): string {
  return new URL(path, page.url()).toString();
}

function localDateTime(minutesAgo: number): string {
  const date = new Date(Date.now() - minutesAgo * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
