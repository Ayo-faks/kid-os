// Phase 3 §3 (D3 slice 6) — weekly safeguarding digest workflows.

import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  proxyActivities,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type * as mattermostActivities from '../activities/mattermost.js';
import type * as safeguardingDigestActivities from '../activities/safeguarding-digest.js';

export interface SafeguardingDigestSweepInput {
  readonly windowMinutes?: number;
  readonly correlationId?: string;
}

export interface SendSafeguardingDigestInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly sinceIso: string;
  readonly nowIso: string;
  readonly correlationId: string;
}

export interface SendSafeguardingDigestResult {
  readonly dispatched: boolean;
  readonly reason?: string;
}

const { findSafeguardingDigestTargets, loadSafeguardingDigest, recordSafeguardingDigestAudit } =
  proxyActivities<typeof safeguardingDigestActivities>({
    retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
    startToCloseTimeout: '30 seconds',
  });

const { postMattermostMessage } = proxyActivities<typeof mattermostActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '20 seconds',
});

export async function SafeguardingDigestSweepWorkflow(
  input: SafeguardingDigestSweepInput = {},
): Promise<{ scanned: number; childWorkflowIds: readonly string[] }> {
  const windowMinutes = input.windowMinutes ?? 7 * 24 * 60;
  const correlationId = input.correlationId ?? `safeguarding-digest-sweep:${workflowInfo().runId}`;

  const now = new Date();
  const nowIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - windowMinutes * 60_000).toISOString();

  const { targets } = await findSafeguardingDigestTargets({ correlationId });

  const childIds: string[] = [];
  for (const target of targets) {
    const childId = `safeguarding-digest:${target.tenantId}:${target.homeId}:${nowIso}`;
    childIds.push(childId);
    await startChild(SendSafeguardingDigestWorkflow, {
      args: [
        {
          correlationId: `${correlationId}:${target.homeId}`,
          homeId: target.homeId,
          nowIso,
          sinceIso,
          tenantId: target.tenantId,
        },
      ],
      cancellationType: ChildWorkflowCancellationType.ABANDON,
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      workflowId: childId,
    });
  }

  return { childWorkflowIds: childIds, scanned: targets.length };
}

export async function SendSafeguardingDigestWorkflow(
  input: SendSafeguardingDigestInput,
): Promise<SendSafeguardingDigestResult> {
  const actor = {
    correlationId: input.correlationId,
    kind: 'system' as const,
    userId: null,
  };

  const digest = await loadSafeguardingDigest({
    actor,
    homeId: input.homeId,
    nowIso: input.nowIso,
    sinceIso: input.sinceIso,
    tenantId: input.tenantId,
  });

  const message =
    `Safeguarding weekly digest (since ${input.sinceIso}): ` +
    `${digest.sensitiveEmailDrafts} sensitive email draft(s), ` +
    `${digest.incidentsOpened} new incident(s) opened, ` +
    `${digest.incidentsAwaitingAction} incident(s) awaiting action.`;

  const post = await postMattermostMessage({
    actor,
    channelKind: 'safeguarding',
    deliveryId: `safeguarding-digest:${input.tenantId}:${input.homeId}:${input.nowIso}`,
    homeId: input.homeId,
    message,
    tenantId: input.tenantId,
  });

  if (!post.delivered) {
    return { dispatched: false, reason: post.reason ?? 'mattermost-failed' };
  }

  await recordSafeguardingDigestAudit({
    actor,
    digest,
    homeId: input.homeId,
    tenantId: input.tenantId,
  });

  return { dispatched: true };
}
