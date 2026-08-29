import {
  APPROVAL_QUERIES,
  APPROVAL_SIGNALS,
  APPROVAL_WORKFLOW_TYPE,
  approvalWorkflowId,
  type ApprovalDecisionSignal,
  type ApprovalRoutingWorkflowInput,
  type ApprovalStateQuery,
  type ApprovalStatus,
} from '@careos/contracts/workflow';
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  patched,
  setHandler,
} from '@temporalio/workflow';

import type * as approvalActivities from '../activities/approvals.js';

const { applyApprovalDecision, createApprovalRequest } = proxyActivities<typeof approvalActivities>(
  {
    retry: {
      initialInterval: '1 second',
      maximumAttempts: 5,
    },
    startToCloseTimeout: '30 seconds',
  },
);

const decideSignal = defineSignal<[ApprovalDecisionSignal]>(APPROVAL_SIGNALS.decide);
const getStateQuery = defineQuery<ApprovalStateQuery>(APPROVAL_QUERIES.getState);

export async function ApprovalRoutingWorkflow(
  input: ApprovalRoutingWorkflowInput,
): Promise<ApprovalStateQuery> {
  const workflowId = approvalWorkflowId(input.approvalId);
  let approvalId = input.approvalId;
  let status: ApprovalStatus = 'pending';
  let requiredRoles = [...input.requiredRoles];
  let signatures = [] as ApprovalStateQuery['signatures'];
  let signaturesRequired = input.signaturesRequired;
  const pendingDecisions: ApprovalDecisionSignal[] = [];
  const roleAware = patched('role-aware-approvals-v1');

  setHandler(getStateQuery, () => ({
    approvalId,
    requiredRoles,
    signatures,
    signaturesRequired,
    status,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
  }));

  setHandler(decideSignal, (payload) => {
    if (status === 'pending') {
      pendingDecisions.push(payload);
    }
  });

  const baseRequest = {
    actor: input.actor,
    approvalId: input.approvalId,
    homeId: input.homeId,
    requestedByUserId: input.requestedByUserId,
    orchestrationName: APPROVAL_WORKFLOW_TYPE,
    runtime: 'temporal' as const,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    summary: input.summary,
    tenantId: input.tenantId,
    title: input.title,
    workflowId,
  };
  const created = await createApprovalRequest(
    roleAware
      ? { ...baseRequest, requiredRoles, signaturesRequired }
      : (baseRequest as Parameters<typeof createApprovalRequest>[0]),
  );
  approvalId = created.approvalId;
  status = created.status;
  if (roleAware) {
    requiredRoles = [...created.requiredRoles];
    signatures = [...created.signatures];
    signaturesRequired = created.signaturesRequired;
  }

  if (status !== 'pending') {
    return snapshot();
  }

  do {
    await condition(() => pendingDecisions.length > 0);
    const decision = pendingDecisions.shift();
    if (decision === undefined) continue;

    const applied = await applyApprovalDecision({
      actor: decision.actor,
      approvalId,
      decidedByUserId: decision.decidedByUserId,
      decision: decision.decision,
      homeId: input.homeId,
      reason: decision.reason,
      tenantId: input.tenantId,
    });
    status = applied.status;
    if (roleAware) {
      requiredRoles = [...applied.requiredRoles];
      signatures = [...applied.signatures];
      signaturesRequired = applied.signaturesRequired;
    }
  } while (roleAware && status === 'pending');

  return snapshot();

  function snapshot(): ApprovalStateQuery {
    return {
      approvalId,
      requiredRoles,
      signatures,
      signaturesRequired,
      status,
      subjectId: input.subjectId,
      subjectType: input.subjectType,
    };
  }
}
