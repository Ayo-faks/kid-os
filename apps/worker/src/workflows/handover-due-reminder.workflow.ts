// Phase 3 §2 (D3 slice 3) — scheduled overdue-handover reminder workflows.

import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  proxyActivities,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type * as handoverDueReminderActivities from '../activities/handover-due-reminders.js';
import type * as mattermostActivities from '../activities/mattermost.js';

export interface HandoverDueReminderSweepInput {
  readonly minOverdueMinutes?: number;
  readonly maxOverdueMinutes?: number;
  readonly correlationId?: string;
}

export interface SendHandoverDueReminderInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly correlationId: string;
}

export interface SendHandoverDueReminderResult {
  readonly dispatched: boolean;
  readonly reason?: string;
}

const { findOverdueHandoverShifts, loadHandoverDueReminderContext, markHandoverDueReminderSent } =
  proxyActivities<typeof handoverDueReminderActivities>({
    retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
    startToCloseTimeout: '30 seconds',
  });

const { postMattermostMessage } = proxyActivities<typeof mattermostActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '20 seconds',
});

export async function HandoverDueReminderSweepWorkflow(
  input: HandoverDueReminderSweepInput = {},
): Promise<{ scanned: number; childWorkflowIds: readonly string[] }> {
  const min = input.minOverdueMinutes ?? 15;
  const max = input.maxOverdueMinutes ?? 240;
  const correlationId =
    input.correlationId ?? `handover-due-reminder-sweep:${workflowInfo().runId}`;

  const { shifts } = await findOverdueHandoverShifts({
    correlationId,
    maxOverdueMinutes: max,
    minOverdueMinutes: min,
    nowIso: new Date().toISOString(),
  });

  const childIds: string[] = [];
  for (const shift of shifts) {
    const childId = `handover-due-reminder:${shift.shiftId}`;
    childIds.push(childId);
    await startChild(SendHandoverDueReminderWorkflow, {
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

export async function SendHandoverDueReminderWorkflow(
  input: SendHandoverDueReminderInput,
): Promise<SendHandoverDueReminderResult> {
  const actor = {
    correlationId: input.correlationId,
    kind: 'system' as const,
    userId: null,
  };

  const context = await loadHandoverDueReminderContext({
    actor,
    homeId: input.homeId,
    shiftId: input.shiftId,
    tenantId: input.tenantId,
  });

  if (context === null) {
    return { dispatched: false, reason: 'shift-not-found' };
  }
  if (context.handoverRecorded) {
    return { dispatched: false, reason: 'handover-already-recorded' };
  }
  if (context.alreadyReminded) {
    return { dispatched: false, reason: 'already-reminded' };
  }

  const endsAt = new Date(context.endsAtIso);
  const minutesOverdue = Math.max(0, Math.round((Date.now() - endsAt.getTime()) / 60_000));
  const message =
    `Handover overdue: the ${context.requiredRole} shift ended ` +
    `~${minutesOverdue} minute${minutesOverdue === 1 ? '' : 's'} ago ` +
    `(${context.endsAtIso}) and no handover has been recorded yet.`;

  const post = await postMattermostMessage({
    actor,
    channelKind: 'home',
    deliveryId: `handover-due-reminder:${input.shiftId}`,
    homeId: input.homeId,
    message,
    tenantId: input.tenantId,
  });

  if (!post.delivered) {
    return { dispatched: false, reason: post.reason ?? 'provider-not-delivered' };
  }

  const marked = await markHandoverDueReminderSent({
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
