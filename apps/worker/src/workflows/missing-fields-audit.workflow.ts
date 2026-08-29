// Phase 3 §2 (D3 slice 5) — nightly missing-mandatory-fields audit workflows.

import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  proxyActivities,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type * as mattermostActivities from '../activities/mattermost.js';
import type * as missingFieldsAuditActivities from '../activities/missing-fields-audit.js';

export interface MissingFieldsAuditSweepInput {
  readonly minAgeMinutes?: number;
  readonly correlationId?: string;
}

export interface SendMissingFieldsReminderInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly correlationId: string;
}

export interface SendMissingFieldsReminderResult {
  readonly dispatched: boolean;
  readonly reason?: string;
}

const {
  findIncidentsMissingMandatoryFields,
  loadMissingFieldsContext,
  markMissingFieldsReminderSent,
} = proxyActivities<typeof missingFieldsAuditActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '30 seconds',
});

const { postMattermostMessage } = proxyActivities<typeof mattermostActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '20 seconds',
});

export async function MissingFieldsAuditSweepWorkflow(
  input: MissingFieldsAuditSweepInput = {},
): Promise<{ scanned: number; childWorkflowIds: readonly string[] }> {
  const minAgeMinutes = input.minAgeMinutes ?? 1440; // 24h by default
  const correlationId = input.correlationId ?? `missing-fields-audit-sweep:${workflowInfo().runId}`;

  const { incidents } = await findIncidentsMissingMandatoryFields({
    correlationId,
    minAgeMinutes,
    nowIso: new Date().toISOString(),
  });

  const childIds: string[] = [];
  for (const incident of incidents) {
    const childId = `missing-fields-reminder:${incident.incidentId}`;
    childIds.push(childId);
    await startChild(SendMissingFieldsReminderWorkflow, {
      args: [
        {
          correlationId: `${correlationId}:${incident.incidentId}`,
          homeId: incident.homeId,
          incidentId: incident.incidentId,
          tenantId: incident.tenantId,
        },
      ],
      cancellationType: ChildWorkflowCancellationType.ABANDON,
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      workflowId: childId,
    });
  }

  return { childWorkflowIds: childIds, scanned: incidents.length };
}

export async function SendMissingFieldsReminderWorkflow(
  input: SendMissingFieldsReminderInput,
): Promise<SendMissingFieldsReminderResult> {
  const actor = {
    correlationId: input.correlationId,
    kind: 'system' as const,
    userId: null,
  };

  const context = await loadMissingFieldsContext({
    actor,
    homeId: input.homeId,
    incidentId: input.incidentId,
    tenantId: input.tenantId,
  });

  if (context === null) {
    return { dispatched: false, reason: 'incident-not-found' };
  }
  if (context.alreadyReminded) {
    return { dispatched: false, reason: 'already-reminded' };
  }
  if (context.missingFields.length === 0) {
    return { dispatched: false, reason: 'no-missing-fields' };
  }
  if (context.status !== 'draft' && context.status !== 'awaiting_fields') {
    return { dispatched: false, reason: `status-${context.status}` };
  }

  const fieldList = context.missingFields.slice(0, 6).join(', ');
  const extra =
    context.missingFields.length > 6 ? ` (+${context.missingFields.length - 6} more)` : '';
  const message =
    `Incident draft ${context.incidentId} is missing mandatory fields ` +
    `[${fieldList}${extra}]. It has been in ${context.status} since ` +
    `${context.createdAtIso}. Please complete or close the draft.`;

  const post = await postMattermostMessage({
    actor,
    channelKind: 'home',
    deliveryId: `missing-fields-reminder:${input.incidentId}`,
    homeId: input.homeId,
    message,
    tenantId: input.tenantId,
  });

  if (!post.delivered) {
    return { dispatched: false, reason: post.reason ?? 'provider-not-delivered' };
  }

  const marked = await markMissingFieldsReminderSent({
    actor,
    homeId: input.homeId,
    incidentId: input.incidentId,
    tenantId: input.tenantId,
  });

  return {
    dispatched: marked.recorded,
    reason: marked.recorded ? undefined : 'reminder-already-recorded',
  };
}
