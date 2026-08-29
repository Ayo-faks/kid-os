import type { ActivityContext } from '@microsoft/durabletask-js';

import {
  findOverdueHandoverShifts,
  loadHandoverDueReminderContext,
  markHandoverDueReminderSent,
} from '../../activities/handover-due-reminders.js';
import { postMattermostMessage } from '../../activities/mattermost.js';
import {
  type CalculateNextHandoverDueFireInput,
  type FindHandoverDueTargetsInput,
  type FindHandoverDueTargetsResult,
  HANDOVER_DUE_ORCHESTRATION_VERSION,
  type HandoverDueDeliveryInput,
  type HandoverDueDeliveryResult,
  HANDOVER_DUE_SWEEP_ORCHESTRATOR,
  SEND_HANDOVER_DUE_ORCHESTRATOR,
  type StartHandoverDueDeliveryInput,
  type StartHandoverDueSweepInput,
} from '../handover-due-reminder.contracts.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

export function calculateNextHandoverDueFireActivity(
  _context: ActivityContext,
  input: CalculateNextHandoverDueFireInput,
): string {
  const after = new Date(input.afterIso);
  if (Number.isNaN(after.getTime())) throw new Error('Handover due afterIso is invalid.');
  if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0) {
    throw new Error('Handover due intervalSeconds must be greater than zero.');
  }
  const intervalMilliseconds = input.intervalSeconds * 1_000;
  return new Date(
    Math.floor(after.getTime() / intervalMilliseconds + 1) * intervalMilliseconds,
  ).toISOString();
}

export async function findHandoverDueTargetsActivity(
  _context: ActivityContext,
  input: FindHandoverDueTargetsInput,
): Promise<FindHandoverDueTargetsResult> {
  try {
    const result = await findOverdueHandoverShifts(input);
    return {
      targets: result.shifts.map((shift) => ({
        homeId: shift.homeId,
        shiftId: shift.shiftId,
        tenantId: shift.tenantId,
      })),
    };
  } catch {
    throw new Error('Handover due target lookup failed.');
  }
}

export async function processHandoverDueDeliveryActivity(
  _context: ActivityContext,
  input: HandoverDueDeliveryInput & { readonly nowIso: string },
): Promise<HandoverDueDeliveryResult> {
  try {
    const actor = { correlationId: input.correlationId, kind: 'system' as const, userId: null };
    const loaded = await loadHandoverDueReminderContext({
      actor,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    });
    if (loaded === null) return { dispatched: false, outcomeCode: 'shift-not-found' };
    if (loaded.handoverRecorded) {
      return { dispatched: false, outcomeCode: 'handover-already-recorded' };
    }
    if (loaded.alreadyReminded) return { dispatched: false, outcomeCode: 'already-reminded' };

    const minutesOverdue = Math.max(
      0,
      Math.round(
        (new Date(input.nowIso).getTime() - new Date(loaded.endsAtIso).getTime()) / 60_000,
      ),
    );
    const post = await postMattermostMessage({
      actor,
      channelKind: 'home',
      deliveryId: `handover-due-reminder:${input.shiftId}`,
      homeId: input.homeId,
      message:
        `Handover overdue: the ${loaded.requiredRole} shift ended ` +
        `~${minutesOverdue} minute${minutesOverdue === 1 ? '' : 's'} ago ` +
        `(${loaded.endsAtIso}) and no handover has been recorded yet.`,
      tenantId: input.tenantId,
    });
    if (!post.delivered) return { dispatched: false, outcomeCode: 'provider-not-delivered' };

    const marked = await markHandoverDueReminderSent({
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
    throw new Error('Handover due delivery processing failed.');
  }
}

export function createStartHandoverDueSweepActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartHandoverDueSweepInput) => Promise<string> {
  return (_context, input) => {
    const orchestrationInput = {
      correlationId: input.correlationId,
      maxOverdueMinutes: input.maxOverdueMinutes,
      minOverdueMinutes: input.minOverdueMinutes,
      scheduledForIso: input.scheduledForIso,
    };
    return start(
      client,
      HANDOVER_DUE_SWEEP_ORCHESTRATOR,
      orchestrationInput,
      input.sweepInstanceId,
    );
  };
}

export function createStartHandoverDueDeliveryActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartHandoverDueDeliveryInput) => Promise<string> {
  return (_context, input) => {
    const orchestrationInput: HandoverDueDeliveryInput = {
      correlationId: input.correlationId,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    };
    return start(
      client,
      SEND_HANDOVER_DUE_ORCHESTRATOR,
      orchestrationInput,
      input.deliveryInstanceId,
    );
  };
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
    version: HANDOVER_DUE_ORCHESTRATION_VERSION,
  });
}
