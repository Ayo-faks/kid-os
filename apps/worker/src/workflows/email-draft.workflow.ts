import {
  APPROVAL_WORKFLOW_TYPE,
  DEFAULT_APPROVALS_TASK_QUEUE,
  EMAIL_DRAFT_QUERIES,
  approvalWorkflowId,
  emailDraftWorkflowId,
  type ApprovalActor,
  type ApprovalRoutingWorkflowInput,
  type EmailDraftActor,
  type EmailDraftStateQuery,
  type EmailDraftStatus,
  type EmailDraftWorkflowInput,
  type EmailSensitivity,
} from '@careos/contracts/workflow';
import {
  ParentClosePolicy,
  defineQuery,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';

import type * as approvalActivities from '../activities/approvals.js';
import type * as emailDraftActivities from '../activities/email-drafts.js';

const { draftEmail } = proxyActivities<typeof emailDraftActivities>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '5 minutes',
});

const { persistEmailDraft, validateEmailDraft, dispatchEmailDraftNotifications } = proxyActivities<
  typeof emailDraftActivities
>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '30 seconds',
});

const { resolveApprovalRequirementActivity } = proxyActivities<typeof approvalActivities>({
  retry: { initialInterval: '1 second', maximumAttempts: 5 },
  startToCloseTimeout: '30 seconds',
});

const getStateQuery = defineQuery<EmailDraftStateQuery>(EMAIL_DRAFT_QUERIES.getState);

export async function EmailDraftWorkflow(input: EmailDraftWorkflowInput): Promise<void> {
  const workflowId = emailDraftWorkflowId(input.emailDraftId);
  let status: EmailDraftStatus = 'draft';
  let sensitivity: EmailSensitivity | null = null;
  let missingMandatory: readonly string[] = [];

  setHandler(getStateQuery, () => ({
    emailDraftId: input.emailDraftId,
    missingMandatory,
    sensitivity,
    status,
  }));

  const draft =
    input.preparedDraft === undefined
      ? await draftEmail({
          correlationId: input.correlationId,
          homeId: input.homeId,
          instructions: input.instructions,
          recipient: input.recipient,
          source: input.source,
          tenantId: input.tenantId,
        })
      : {
          body: input.preparedDraft.body,
          confidence: 1,
          formData: {
            body: input.preparedDraft.body,
            recipient: input.recipient,
            sensitivity: input.preparedDraft.sensitivity,
            sensitivity_reasons: input.preparedDraft.sensitivityReasons,
            subject: input.preparedDraft.subject,
          },
          missingMandatory: [],
          promptHash: undefined,
          refused: false,
          sensitivity: input.preparedDraft.sensitivity,
          sensitivityReasons: input.preparedDraft.sensitivityReasons,
          subject: input.preparedDraft.subject,
        };

  if (draft.refused) {
    status = 'rejected';
    missingMandatory = draft.missingMandatory;
    throw new Error(
      `Email draft ${input.emailDraftId} refused (prompt-injection or mutation request).`,
    );
  }

  const validation = await validateEmailDraft({ formData: draft.formData });
  missingMandatory = validation.missingMandatory;
  if (!validation.valid) {
    status = 'rejected';
    throw new Error(
      `Email draft ${input.emailDraftId} failed validation: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
  }

  sensitivity = draft.sensitivity;
  const approvalRequirement = await resolveApprovalRequirementActivity({
    context: { sensitivity: draft.sensitivity },
    skill: 'draft_email',
  });
  const targetStatus: EmailDraftStatus =
    approvalRequirement.level === 'none' ? 'draft' : 'needs_review';

  const actor: EmailDraftActor = {
    ...(input.actor ?? {
      correlationId: input.correlationId,
      kind: 'user' as const,
      userId: input.authorUserId,
    }),
    ...(draft.promptHash !== undefined ? { promptHash: draft.promptHash } : {}),
  };

  const persisted = await persistEmailDraft({
    actor,
    authorUserId: input.authorUserId,
    body: draft.body,
    emailDraftId: input.emailDraftId,
    homeId: input.homeId,
    recipient: input.recipient,
    sensitivity: draft.sensitivity,
    sensitivityReasons: draft.sensitivityReasons,
    source: input.source,
    status: targetStatus,
    subject: draft.subject,
    tenantId: input.tenantId,
    workflowId,
  });

  status = persisted.status;

  await dispatchEmailDraftNotifications({
    actor,
    emailDraftId: input.emailDraftId,
    homeId: input.homeId,
    sensitivity: draft.sensitivity,
    status,
    tenantId: input.tenantId,
  });

  if (
    status === 'needs_review' &&
    (approvalRequirement.signaturesRequired === 1 || approvalRequirement.signaturesRequired === 2)
  ) {
    const approvalActor: ApprovalActor = actor;
    await startChild(APPROVAL_WORKFLOW_TYPE, {
      args: [
        {
          actor: approvalActor,
          approvalId: input.emailDraftId,
          homeId: input.homeId,
          requestedByUserId: input.authorUserId,
          requiredRoles: approvalRequirement.requiredRoles,
          signaturesRequired: approvalRequirement.signaturesRequired,
          subjectId: input.emailDraftId,
          subjectType: 'email_draft',
          summary: draft.body,
          tenantId: input.tenantId,
          title: draft.subject,
        } satisfies ApprovalRoutingWorkflowInput,
      ],
      parentClosePolicy: ParentClosePolicy.ABANDON,
      taskQueue: input.approvalTaskQueue ?? DEFAULT_APPROVALS_TASK_QUEUE,
      workflowId: approvalWorkflowId(input.emailDraftId),
    });
  }
}
