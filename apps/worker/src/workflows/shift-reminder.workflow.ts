// Phase 3 §2 (D3 wiring) — scheduled shift-reminder workflows.
//
// `ShiftReminderSweepWorkflow` is the entry point for the Temporal
// schedule. It calls `findUpcomingShifts` under a system actor, then
// starts a child `SendShiftReminderWorkflow` per shift so each tenant's
// dispatch runs in its own (per-tenant) workflow execution. Children
// run in parallel; failure of any one does not break the sweep.

import {
  proxyActivities,
  startChild,
  ParentClosePolicy,
  ChildWorkflowCancellationType,
  workflowInfo,
} from '@temporalio/workflow';

import type * as mattermostActivities from '../activities/mattermost.js';
import type * as shiftReminderActivities from '../activities/shift-reminders.js';

export interface ShiftReminderSweepInput {
  readonly minLookaheadMinutes?: number;
  readonly maxLookaheadMinutes?: number;
  readonly correlationId?: string;
}

export interface SendShiftReminderInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly correlationId: string;
}

export interface SendShiftReminderResult {
  readonly dispatched: boolean;
  readonly reason?: string;
}

const { findUpcomingShifts, loadShiftReminderContext, markShiftReminderSent } = proxyActivities<
  typeof shiftReminderActivities
>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '30 seconds',
});

const { postMattermostMessage } = proxyActivities<typeof mattermostActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '20 seconds',
});

export async function ShiftReminderSweepWorkflow(
  input: ShiftReminderSweepInput = {},
): Promise<{ scanned: number; childWorkflowIds: readonly string[] }> {
  const min = input.minLookaheadMinutes ?? 25;
  const max = input.maxLookaheadMinutes ?? 35;
  const correlationId = input.correlationId ?? `shift-reminder-sweep:${workflowInfo().runId}`;

  const { shifts } = await findUpcomingShifts({
    correlationId,
    maxLookaheadMinutes: max,
    minLookaheadMinutes: min,
    nowIso: new Date().toISOString(),
  });

  const childIds: string[] = [];
  for (const shift of shifts) {
    const childId = `shift-reminder:${shift.shiftId}`;
    childIds.push(childId);
    await startChild(SendShiftReminderWorkflow, {
      args: [
        {
          correlationId: `${correlationId}:${shift.shiftId}`,
          homeId: shift.homeId,
          shiftId: shift.shiftId,
          tenantId: shift.tenantId,
        },
      ],
      cancellationType: ChildWorkflowCancellationType.ABANDON,
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      workflowId: childId,
    });
  }

  return { childWorkflowIds: childIds, scanned: shifts.length };
}

export async function SendShiftReminderWorkflow(
  input: SendShiftReminderInput,
): Promise<SendShiftReminderResult> {
  const actor = {
    correlationId: input.correlationId,
    kind: 'system' as const,
    userId: null,
  };

  const context = await loadShiftReminderContext({
    actor,
    homeId: input.homeId,
    shiftId: input.shiftId,
    tenantId: input.tenantId,
  });

  if (context === null) {
    return { dispatched: false, reason: 'shift-not-found' };
  }
  if (context.alreadyReminded) {
    return { dispatched: false, reason: 'already-reminded' };
  }

  const startsAt = new Date(context.startsAtIso);
  const minutesUntil = Math.round((startsAt.getTime() - Date.now()) / 60_000);
  const gap = context.minHeadcount - context.assignedHeadcount;
  const gapSuffix = gap > 0 ? ` ${gap} ${gap === 1 ? 'gap' : 'gaps'} still need filling.` : '';
  const message =
    `Shift reminder: a ${context.requiredRole} shift starts in ` +
    `~${minutesUntil} minute${minutesUntil === 1 ? '' : 's'} ` +
    `(${context.startsAtIso}).${gapSuffix}`;

  const post = await postMattermostMessage({
    actor,
    channelKind: 'home',
    deliveryId: `shift-reminder:${input.shiftId}`,
    homeId: input.homeId,
    message,
    tenantId: input.tenantId,
  });

  if (!post.delivered) {
    return { dispatched: false, reason: post.reason ?? 'provider-not-delivered' };
  }

  const marked = await markShiftReminderSent({
    actor,
    homeId: input.homeId,
    shiftId: input.shiftId,
    tenantId: input.tenantId,
  });

  return {
    dispatched: marked.recorded,
    reason: marked.recorded ? undefined : 'reminder-already-recorded',
  };
}
