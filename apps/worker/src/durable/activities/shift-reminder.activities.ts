import type {
  FindUpcomingShiftsInput,
  FindUpcomingShiftsResult,
  LoadShiftReminderContextInput,
  MarkShiftReminderSentInput,
  MarkShiftReminderSentResult,
  PostMattermostMessageInput,
  PostMattermostMessageResult,
  ShiftReminderContext,
} from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { postMattermostMessage } from '../../activities/mattermost.js';
import {
  findUpcomingShifts,
  loadShiftReminderContext,
  markShiftReminderSent,
} from '../../activities/shift-reminders.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';
import {
  SEND_SHIFT_REMINDER_ORCHESTRATOR,
  SHIFT_REMINDER_ORCHESTRATION_VERSION,
  SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
  type CalculateNextShiftReminderFireInput,
  type ProcessShiftReminderDeliveryInput,
  type ShiftReminderDeliveryResult,
  type StartShiftReminderDeliveryInput,
  type StartShiftReminderSweepInput,
} from '../shift-reminder.contracts.js';

export function calculateNextShiftReminderFireActivity(
  _context: ActivityContext,
  input: CalculateNextShiftReminderFireInput,
): string {
  const after = new Date(input.afterIso);
  if (Number.isNaN(after.getTime())) {
    throw new Error('Shift reminder afterIso must be a valid ISO timestamp.');
  }
  if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0) {
    throw new Error('Shift reminder intervalSeconds must be greater than zero.');
  }

  const intervalMilliseconds = input.intervalSeconds * 1_000;
  const nextMilliseconds =
    Math.floor(after.getTime() / intervalMilliseconds + 1) * intervalMilliseconds;
  return new Date(nextMilliseconds).toISOString();
}

export function findUpcomingShiftsActivity(
  _context: ActivityContext,
  input: FindUpcomingShiftsInput,
): Promise<FindUpcomingShiftsResult> {
  return findUpcomingShifts(input);
}

export function loadShiftReminderContextActivity(
  _context: ActivityContext,
  input: LoadShiftReminderContextInput,
): Promise<ShiftReminderContext | null> {
  return loadShiftReminderContext(input);
}

export function postMattermostMessageActivity(
  _context: ActivityContext,
  input: PostMattermostMessageInput,
): Promise<Pick<PostMattermostMessageResult, 'delivered'>> {
  return postMattermostMessage(input).then((result) => ({ delivered: result.delivered }));
}

export function markShiftReminderSentActivity(
  _context: ActivityContext,
  input: MarkShiftReminderSentInput,
): Promise<MarkShiftReminderSentResult> {
  return markShiftReminderSent(input);
}

export async function processShiftReminderDeliveryActivity(
  _context: ActivityContext,
  input: ProcessShiftReminderDeliveryInput,
): Promise<ShiftReminderDeliveryResult> {
  try {
    const actor = {
      correlationId: input.correlationId,
      kind: 'system' as const,
      userId: null,
    };
    const loaded = await loadShiftReminderContext({
      actor,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    });
    if (loaded === null) return { dispatched: false, outcomeCode: 'shift-not-found' };
    if (loaded.alreadyReminded) return { dispatched: false, outcomeCode: 'already-reminded' };

    const minutesUntil = Math.round(
      (new Date(loaded.startsAtIso).getTime() - new Date(input.nowIso).getTime()) / 60_000,
    );
    const gap = loaded.minHeadcount - loaded.assignedHeadcount;
    const gapSuffix = gap > 0 ? ` ${gap} ${gap === 1 ? 'gap' : 'gaps'} still need filling.` : '';
    const post = await postMattermostMessage({
      actor,
      channelKind: 'home',
      deliveryId: `shift-reminder:${input.shiftId}`,
      homeId: input.homeId,
      message:
        `Shift reminder: a ${loaded.requiredRole} shift starts in ` +
        `~${minutesUntil} minute${minutesUntil === 1 ? '' : 's'} ` +
        `(${loaded.startsAtIso}).${gapSuffix}`,
      tenantId: input.tenantId,
    });
    if (!post.delivered) return { dispatched: false, outcomeCode: 'provider-not-delivered' };

    const marked = await markShiftReminderSent({
      actor,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    });
    return {
      dispatched: marked.recorded,
      ...(marked.recorded ? {} : { outcomeCode: 'reminder-already-recorded' as const }),
    };
  } catch {
    throw new Error('Shift reminder delivery processing failed.');
  }
}

export function createStartShiftReminderSweepActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartShiftReminderSweepInput) => Promise<string> {
  return (_context, input) => {
    const orchestrationInput = {
      correlationId: input.correlationId,
      maxLookaheadMinutes: input.maxLookaheadMinutes,
      minLookaheadMinutes: input.minLookaheadMinutes,
      scheduledForIso: input.scheduledForIso,
    };
    assertDurableInstanceId(input.sweepInstanceId);
    assertDurablePayload(orchestrationInput, 'shiftReminderSweep');
    return scheduleDurableOrchestrationIdempotently(
      client,
      SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
      orchestrationInput,
      {
        instanceId: input.sweepInstanceId,
        version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
      },
    );
  };
}

export function createStartShiftReminderDeliveryActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartShiftReminderDeliveryInput) => Promise<string> {
  return (_context, input) => {
    const orchestrationInput = {
      correlationId: input.correlationId,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    };
    assertDurableInstanceId(input.deliveryInstanceId);
    assertDurablePayload(orchestrationInput, 'shiftReminderDelivery');
    return scheduleDurableOrchestrationIdempotently(
      client,
      SEND_SHIFT_REMINDER_ORCHESTRATOR,
      orchestrationInput,
      {
        instanceId: input.deliveryInstanceId,
        version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
      },
    );
  };
}
