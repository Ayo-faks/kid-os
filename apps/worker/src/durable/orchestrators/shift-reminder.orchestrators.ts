import type { FindUpcomingShiftsResult } from '@careos/contracts';
import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
  whenAll,
} from '@microsoft/durabletask-js';

import { assertDurablePayload } from '../payload-policy.js';
import {
  CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
  FIND_UPCOMING_SHIFTS_ACTIVITY,
  PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  type ProcessShiftReminderDeliveryInput,
  type ShiftReminderDeliveryInput,
  type ShiftReminderDeliveryResult,
  SHIFT_REMINDER_ORCHESTRATION_VERSION,
  START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  START_SHIFT_REMINDER_SWEEP_ACTIVITY,
  type CalculateNextShiftReminderFireInput,
  type ShiftReminderScheduleInput,
  type ShiftReminderSweepInput,
  shiftReminderDeliveryInstanceId,
  shiftReminderSweepInstanceId,
  type StartShiftReminderDeliveryInput,
  type StartShiftReminderSweepInput,
} from '../shift-reminder.contracts.js';

const SCHEDULE_ACTIVITY_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 2_000,
  maxNumberOfAttempts: 3,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* shiftReminderScheduleOrchestrator(
  context: OrchestrationContext,
  input: ShiftReminderScheduleInput = {},
): AsyncGenerator<Task<unknown>, void, unknown> {
  assertDurablePayload(input, 'shiftReminderSchedule');
  const intervalSeconds = input.intervalSeconds ?? 300;
  const maxLookaheadMinutes = input.maxLookaheadMinutes ?? 35;
  const minLookaheadMinutes = input.minLookaheadMinutes ?? 25;
  const nextFireResult = yield context.callActivity<CalculateNextShiftReminderFireInput, string>(
    CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
    {
      afterIso: context.currentUtcDateTime.toISOString(),
      intervalSeconds,
    },
    { retry: SCHEDULE_ACTIVITY_RETRY, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
  );
  if (typeof nextFireResult !== 'string') {
    throw new Error('calculateNextShiftReminderFireActivityV1 returned an invalid result.');
  }
  const nextFireAtIso = nextFireResult;

  context.setCustomStatus({
    kind: 'shift-reminder-schedule',
    nextFireAtIso,
    version: context.version || SHIFT_REMINDER_ORCHESTRATION_VERSION,
  });
  yield context.createTimer(new Date(nextFireAtIso));

  const sweepInstanceId = shiftReminderSweepInstanceId(nextFireAtIso);
  yield context.callActivity<StartShiftReminderSweepInput, string>(
    START_SHIFT_REMINDER_SWEEP_ACTIVITY,
    {
      correlationId: sweepInstanceId,
      maxLookaheadMinutes,
      minLookaheadMinutes,
      scheduledForIso: nextFireAtIso,
      sweepInstanceId,
    },
    { retry: SCHEDULE_ACTIVITY_RETRY, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
  );

  context.continueAsNew(input, false);
}

// durabletask-js 0.3.0 declares TOrchestrator as a synchronous Generator but its executor
// recognizes only AsyncGenerator. Keep the compatibility cast at this boundary.
export const ShiftReminderScheduleOrchestrator =
  shiftReminderScheduleOrchestrator as unknown as TOrchestrator;

interface ShiftReminderSweepOutput {
  readonly deliveryInstanceIds: readonly string[];
  readonly scanned: number;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* shiftReminderSweepOrchestrator(
  context: OrchestrationContext,
  input: ShiftReminderSweepInput,
): AsyncGenerator<Task<unknown>, ShiftReminderSweepOutput, unknown> {
  assertDurablePayload(input, 'shiftReminderSweep');
  const lookupResult = yield context.callActivity(
    FIND_UPCOMING_SHIFTS_ACTIVITY,
    {
      correlationId: input.correlationId,
      maxLookaheadMinutes: input.maxLookaheadMinutes,
      minLookaheadMinutes: input.minLookaheadMinutes,
      nowIso: context.currentUtcDateTime.toISOString(),
    },
    { retry: SCHEDULE_ACTIVITY_RETRY, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
  );
  if (!isFindUpcomingShiftsResult(lookupResult)) {
    throw new Error('findUpcomingShiftsActivityV1 returned an invalid result.');
  }

  const starts = lookupResult.shifts.map((shift) => {
    const deliveryInstanceId = shiftReminderDeliveryInstanceId(shift.shiftId);
    return context.callActivity<StartShiftReminderDeliveryInput, string>(
      START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
      {
        correlationId: `${input.correlationId}:${shift.shiftId}`,
        deliveryInstanceId,
        homeId: shift.homeId,
        shiftId: shift.shiftId,
        tenantId: shift.tenantId,
      },
      { retry: SCHEDULE_ACTIVITY_RETRY, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
    );
  });
  const deliveryResult = starts.length === 0 ? [] : yield whenAll(starts);
  if (!isStringArray(deliveryResult)) {
    throw new Error('startShiftReminderDeliveryActivityV1 returned an invalid result.');
  }

  return { deliveryInstanceIds: deliveryResult, scanned: lookupResult.shifts.length };
}

// See the TOrchestrator compatibility note above.
export const ShiftReminderSweepOrchestrator =
  shiftReminderSweepOrchestrator as unknown as TOrchestrator;

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* sendShiftReminderOrchestrator(
  context: OrchestrationContext,
  input: ShiftReminderDeliveryInput,
): AsyncGenerator<Task<unknown>, ShiftReminderDeliveryResult, unknown> {
  assertDurablePayload(input, 'shiftReminderDelivery');
  const result = yield context.callActivity<
    ProcessShiftReminderDeliveryInput,
    ShiftReminderDeliveryResult
  >(
    PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY,
    { ...input, nowIso: context.currentUtcDateTime.toISOString() },
    { retry: SCHEDULE_ACTIVITY_RETRY, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
  );
  return parseDeliveryResult(result);
}

export const SendShiftReminderOrchestrator =
  sendShiftReminderOrchestrator as unknown as TOrchestrator;

function isFindUpcomingShiftsResult(value: unknown): value is FindUpcomingShiftsResult {
  return (
    typeof value === 'object' && value !== null && 'shifts' in value && Array.isArray(value.shifts)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseDeliveryResult(value: unknown): ShiftReminderDeliveryResult {
  if (typeof value !== 'object' || value === null) throw invalidDelivery();
  const result = value as Record<string, unknown>;
  const codes = [
    'already-reminded',
    'provider-not-delivered',
    'reminder-already-recorded',
    'shift-not-found',
  ];
  if (
    Object.keys(result).some((key) => !['dispatched', 'outcomeCode'].includes(key)) ||
    typeof result.dispatched !== 'boolean' ||
    (result.outcomeCode !== undefined &&
      (typeof result.outcomeCode !== 'string' || !codes.includes(result.outcomeCode)))
  ) {
    throw invalidDelivery();
  }
  const parsed: ShiftReminderDeliveryResult = {
    dispatched: result.dispatched,
    ...(result.outcomeCode === undefined
      ? {}
      : { outcomeCode: result.outcomeCode as ShiftReminderDeliveryResult['outcomeCode'] }),
  };
  assertDurablePayload(parsed, 'shiftReminderDeliveryResult');
  return parsed;
}

function invalidDelivery(): Error {
  return new Error('Shift reminder delivery returned an invalid result.');
}
