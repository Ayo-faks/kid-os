import type { ActivityContext } from '@microsoft/durabletask-js';

import { postMattermostMessage } from '../../activities/mattermost.js';
import {
  findSafeguardingDigestTargets,
  hasSafeguardingDigestAudit,
  loadSafeguardingDigest,
  recordSafeguardingDigestAudit,
} from '../../activities/safeguarding-digest.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';
import {
  type CalculateNextSafeguardingDigestFireInput,
  SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  type SafeguardingDigestDeliveryInput,
  type SafeguardingDigestDeliveryResult,
  SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
  SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
  type StartSafeguardingDigestDeliveryInput,
  type StartSafeguardingDigestSweepInput,
} from '../safeguarding-digest.contracts.js';

export function calculateNextSafeguardingDigestFireActivity(
  _context: ActivityContext,
  input: CalculateNextSafeguardingDigestFireInput,
): string {
  const after = new Date(input.afterIso);
  if (Number.isNaN(after.getTime())) throw new Error('Safeguarding digest afterIso is invalid.');
  if (input.intervalSeconds !== undefined) {
    if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0) {
      throw new Error('Safeguarding digest intervalSeconds must be greater than zero.');
    }
    return new Date(after.getTime() + input.intervalSeconds * 1_000).toISOString();
  }

  const current = londonParts(after);
  let daysUntilMonday = (1 - current.weekday + 7) % 7;
  if (daysUntilMonday === 0 && current.hour >= 8) daysUntilMonday = 7;
  const target = addCalendarDays(current, daysUntilMonday);
  return londonLocalToUtc(target, 8).toISOString();
}

export async function findSafeguardingDigestTargetsActivity(
  _context: ActivityContext,
  input: { readonly correlationId: string },
): Promise<{ readonly targets: readonly SafeguardingDigestTargetResult[] }> {
  try {
    const result = await findSafeguardingDigestTargets(input);
    return {
      targets: result.targets.map((target) => ({
        homeId: target.homeId,
        tenantId: target.tenantId,
      })),
    };
  } catch {
    throw new Error('Safeguarding digest target lookup failed.');
  }
}

interface SafeguardingDigestTargetResult {
  readonly homeId: string;
  readonly tenantId: string;
}

export async function processSafeguardingDigestDeliveryActivity(
  _context: ActivityContext,
  input: SafeguardingDigestDeliveryInput,
): Promise<SafeguardingDigestDeliveryResult> {
  try {
    const actor = { correlationId: input.correlationId, kind: 'system' as const, userId: null };
    if (
      await hasSafeguardingDigestAudit({
        actor,
        homeId: input.homeId,
        nowIso: input.nowIso,
        tenantId: input.tenantId,
      })
    ) {
      return { dispatched: true, outcomeCode: 'already-recorded' };
    }

    const digest = await loadSafeguardingDigest({
      actor,
      homeId: input.homeId,
      nowIso: input.nowIso,
      sinceIso: input.sinceIso,
      tenantId: input.tenantId,
    });
    const post = await postMattermostMessage({
      actor,
      channelKind: 'safeguarding',
      deliveryId: `safeguarding-digest:${input.tenantId}:${input.homeId}:${input.nowIso}`,
      homeId: input.homeId,
      message:
        `Safeguarding weekly digest (since ${input.sinceIso}): ` +
        `${digest.sensitiveEmailDrafts} sensitive email draft(s), ` +
        `${digest.incidentsOpened} new incident(s) opened, ` +
        `${digest.incidentsAwaitingAction} incident(s) awaiting action.`,
      tenantId: input.tenantId,
    });
    if (!post.delivered) return { dispatched: false, outcomeCode: 'provider-not-delivered' };

    const audit = await recordSafeguardingDigestAudit({
      actor,
      digest,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });
    return audit.recorded
      ? { dispatched: true }
      : { dispatched: false, outcomeCode: 'audit-not-recorded' };
  } catch {
    throw new Error('Safeguarding digest delivery processing failed.');
  }
}

export function createStartSafeguardingDigestSweepActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartSafeguardingDigestSweepInput) => Promise<string> {
  return (_context, input) =>
    start(
      client,
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      {
        correlationId: input.correlationId,
        nowIso: input.nowIso,
        sinceIso: input.sinceIso,
      },
      input.sweepInstanceId,
    );
}

export function createStartSafeguardingDigestDeliveryActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartSafeguardingDigestDeliveryInput) => Promise<string> {
  return (_context, input) =>
    start(
      client,
      SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
      {
        correlationId: input.correlationId,
        homeId: input.homeId,
        nowIso: input.nowIso,
        sinceIso: input.sinceIso,
        tenantId: input.tenantId,
      },
      input.deliveryInstanceId,
    );
}

function start(
  client: DurableOrchestrationStarter,
  orchestrator: string,
  input: unknown,
  instanceId: string,
): Promise<string> {
  assertDurableInstanceId(instanceId);
  assertDurablePayload(input, orchestrator);
  return scheduleDurableOrchestrationIdempotently(client, orchestrator, input, {
    instanceId,
    version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  });
}

interface LondonDate {
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
  readonly year: number;
}

interface LondonDateTime extends LondonDate {
  readonly hour: number;
}

function londonParts(date: Date): LondonDateTime {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    month: '2-digit',
    timeZone: 'Europe/London',
    weekday: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Fri: 5,
    Mon: 1,
    Sat: 6,
    Sun: 0,
    Thu: 4,
    Tue: 2,
    Wed: 3,
  };
  const day = Number(values.day);
  const hour = Number(values.hour);
  const month = Number(values.month);
  const year = Number(values.year);
  const weekday = values.weekday === undefined ? undefined : weekdays[values.weekday];
  if (![day, hour, month, year, weekday].every((value) => Number.isInteger(value))) {
    throw new Error('Safeguarding digest timezone conversion failed.');
  }
  return { day, hour, month, weekday: weekday as number, year };
}

function addCalendarDays(value: LondonDate, days: number): LondonDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    day: next.getUTCDate(),
    month: next.getUTCMonth() + 1,
    weekday: (value.weekday + days) % 7,
    year: next.getUTCFullYear(),
  };
}

function londonLocalToUtc(value: LondonDate, hour: number): Date {
  const targetAsUtc = Date.UTC(value.year, value.month - 1, value.day, hour);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = londonParts(new Date(candidate));
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour);
    const correction = targetAsUtc - actualAsUtc;
    if (correction === 0) return new Date(candidate);
    candidate += correction;
  }
  throw new Error('Safeguarding digest timezone conversion did not converge.');
}
