import type {
  RetentionSweepDurableResult,
  RetentionSweepDurableWorkflowInput,
} from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { applyRetentionPolicy, listActiveRetentionPolicies } from '../../activities/retention.js';
import { withTenantContext } from '../../db/pg.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';
import {
  type CalculateNextRetentionFireInput,
  RETENTION_ORCHESTRATION_VERSION,
  RETENTION_SWEEP_ORCHESTRATOR,
  type StartRetentionSweepInput,
} from '../retention.contracts.js';

export async function processRetentionSweepActivity(
  _context: ActivityContext,
  input: RetentionSweepDurableWorkflowInput,
): Promise<RetentionSweepDurableResult> {
  try {
    const list = await listActiveRetentionPolicies({ correlationId: input.correlationId });
    let policiesApplied = 0;
    let totalAffected = 0;
    let totalScanned = 0;

    for (const policy of list.policies) {
      const result = await applyRetentionPolicy({
        actor: { correlationId: input.correlationId, kind: 'system', userId: null },
        nowIso: input.nowIso,
        policy,
        workflowId: input.sweepId,
      });
      policiesApplied += 1;
      totalAffected += result.affectedCount;
      totalScanned += result.scannedCount;
    }

    await updateOwnerStatus(input, 'completed');
    return { policiesApplied, sweepId: input.sweepId, totalAffected, totalScanned };
  } catch {
    throw new Error('Retention sweep processing failed.');
  }
}

export async function finalizeRetentionSweepFailureActivity(
  _context: ActivityContext,
  input: RetentionSweepDurableWorkflowInput,
): Promise<void> {
  try {
    await updateOwnerStatus(input, 'failed');
  } catch {
    throw new Error('Retention sweep failure finalization failed.');
  }
}

export function calculateNextRetentionFireActivity(
  _context: ActivityContext,
  input: CalculateNextRetentionFireInput,
): string {
  const after = new Date(input.afterIso);
  if (Number.isNaN(after.getTime())) {
    throw new Error('Retention schedule afterIso must be a valid ISO timestamp.');
  }
  if (!Number.isInteger(input.hourLocal) || input.hourLocal < 0 || input.hourLocal > 23) {
    throw new Error('Retention schedule hourLocal must be an integer from 0 to 23.');
  }

  const current = localParts(after, input.timeZone);
  const targetDate =
    current.hour < input.hourLocal
      ? { day: current.day, month: current.month, year: current.year }
      : addCalendarDay(current);
  return localDateTimeToUtc(targetDate, input.hourLocal, input.timeZone).toISOString();
}

export function createStartRetentionSweepActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartRetentionSweepInput) => Promise<string> {
  return (_context, input) => {
    const orchestrationInput: RetentionSweepDurableWorkflowInput = {
      correlationId: input.correlationId,
      nowIso: input.nowIso,
      sweepId: input.sweepId,
    };
    assertDurableInstanceId(input.sweepInstanceId);
    assertDurablePayload(orchestrationInput, 'retentionSweep');
    return scheduleDurableOrchestrationIdempotently(
      client,
      RETENTION_SWEEP_ORCHESTRATOR,
      orchestrationInput,
      {
        instanceId: input.sweepInstanceId,
        version: RETENTION_ORCHESTRATION_VERSION,
      },
    );
  };
}

async function updateOwnerStatus(
  input: RetentionSweepDurableWorkflowInput,
  status: 'completed' | 'failed',
): Promise<void> {
  const owner = input.owner;
  if (owner === undefined) return;
  await withTenantContext(
    {
      actor: { correlationId: input.correlationId, kind: 'system', userId: null },
      homeId: owner.homeId,
      tenantId: owner.tenantId,
    },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE id = $1::uuid
            AND workflow_kind = 'retention-sweep'
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [owner.workflowInstanceId, status],
      );
    },
  );
}

interface LocalDate {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

interface LocalDateTime extends LocalDate {
  readonly hour: number;
}

function localParts(date: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const { day, hour, month, year } = values;
  if (
    typeof year !== 'number' ||
    !Number.isInteger(year) ||
    typeof month !== 'number' ||
    !Number.isInteger(month) ||
    typeof day !== 'number' ||
    !Number.isInteger(day) ||
    typeof hour !== 'number' ||
    !Number.isInteger(hour)
  ) {
    throw new Error('Retention schedule timezone conversion failed.');
  }
  return {
    day,
    hour,
    month,
    year,
  };
}

function addCalendarDay(value: LocalDate): LocalDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return {
    day: next.getUTCDate(),
    month: next.getUTCMonth() + 1,
    year: next.getUTCFullYear(),
  };
}

function localDateTimeToUtc(value: LocalDate, hour: number, timeZone: string): Date {
  const targetAsUtc = Date.UTC(value.year, value.month - 1, value.day, hour);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour);
    const correction = targetAsUtc - actualAsUtc;
    if (correction === 0) return new Date(candidate);
    candidate += correction;
  }
  throw new Error('Retention schedule timezone conversion did not converge.');
}
