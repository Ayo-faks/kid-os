// IncidentReportWorkflow — Phase 1 §5 state machine.
//
// States: Draft → AwaitingFields → AwaitingApproval → Approved → Exported
// (Rejected is a terminal alternative reachable from AwaitingApproval).
//
// Writes happen through activities only. The API controller path NEVER mutates
// the database; it only signals/queries this workflow. Crucially,
// `draftIncidentFromText` is allowed to populate the form but MUST NOT
// auto-submit — submission is only via the `submitForApproval` signal.

import {
  APPROVAL_WORKFLOW_TYPE,
  DEFAULT_APPROVALS_TASK_QUEUE,
  INCIDENT_FOLLOW_UPS_TASK_QUEUE,
  INCIDENT_FOLLOW_UP_WORKFLOW_TYPE,
  INCIDENT_QUERIES,
  INCIDENT_SIGNALS,
  incidentWorkflowId,
  type ApproveSignal,
  type ExportSignal,
  type IncidentActor,
  type IncidentFollowUpActionWorkflowInput,
  type IncidentReportWorkflowInput,
  type IncidentStateQuery,
  type IncidentStatus,
  type ApprovalRoutingWorkflowInput,
  type ApprovalActor,
  type ApprovalStateQuery,
  type SubmitForApprovalSignal,
  type UpdateDraftSignal,
} from '@careos/contracts/workflow';
import {
  ParentClosePolicy,
  condition,
  defineQuery,
  defineSignal,
  log,
  patched,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';

import type * as approvalActivities from '../activities/approvals.js';
import type * as followUpActivities from '../activities/incident-follow-ups.js';
import type * as activities from '../activities/incidents.js';

const {
  exportPdf,
  persistIncidentVersion,
  routeForApproval,
  resolveIncidentApprovalRequirement,
  validateAgainstSchema,
  writeAuditEvent,
} = proxyActivities<typeof activities>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '30 seconds',
});

const { ensureIncidentFollowUpActions } = proxyActivities<typeof followUpActivities>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '30 seconds',
});

const updateDraftSignal = defineSignal<[UpdateDraftSignal]>(INCIDENT_SIGNALS.updateDraft);
const submitSignal = defineSignal<[SubmitForApprovalSignal]>(INCIDENT_SIGNALS.submitForApproval);
const approveSignal = defineSignal<[ApproveSignal]>(INCIDENT_SIGNALS.approve);
const exportSignal = defineSignal<[ExportSignal]>(INCIDENT_SIGNALS.exportPdf);
const getStateQuery = defineQuery<IncidentStateQuery>(INCIDENT_QUERIES.getState);

interface PendingSubmission {
  readonly actor: IncidentActor;
}

interface PendingApproval {
  readonly actor: IncidentActor;
  readonly approverUserId: string;
}

interface PendingExport {
  readonly actor: IncidentActor;
}

export async function IncidentReportWorkflow(input: IncidentReportWorkflowInput): Promise<void> {
  const workflowId = incidentWorkflowId(input.incidentId);
  const approvalTaskQueue = input.approvalTaskQueue ?? DEFAULT_APPROVALS_TASK_QUEUE;
  const { createApprovalRequest } = proxyActivities<typeof approvalActivities>({
    retry: {
      initialInterval: '1 second',
      maximumAttempts: 5,
    },
    startToCloseTimeout: '30 seconds',
    taskQueue: approvalTaskQueue,
  });

  // Mutable workflow state. We expose a snapshot via the getState query.
  let status: IncidentStatus = 'draft';
  let currentVersion = 0;
  let formData: Record<string, unknown> = { ...(input.initialFormData ?? {}) };
  let missingMandatory: readonly string[] = [];
  let exportObjectKey: string | undefined;

  let pendingSubmit: PendingSubmission | undefined;
  let pendingApproval: PendingApproval | undefined;
  let pendingExport: PendingExport | undefined;
  let pendingDraft: UpdateDraftSignal | undefined;

  setHandler(getStateQuery, () => ({
    currentVersion,
    exportObjectKey,
    formData,
    missingMandatory,
    status,
  }));

  setHandler(updateDraftSignal, (payload) => {
    pendingDraft = payload;
  });
  setHandler(submitSignal, (payload) => {
    pendingSubmit = payload;
  });
  setHandler(approveSignal, (payload) => {
    pendingApproval = payload;
  });
  setHandler(exportSignal, (payload) => {
    pendingExport = payload;
  });

  // Validate before the first persistence. Partial drafts remain saveable, but
  // invalid input is explicitly stored as awaiting_fields with validation
  // evidence rather than appearing as a valid draft.
  const initialValidation = await validateAgainstSchema({
    formData,
    formTemplate: input.formTemplate,
  });
  missingMandatory = initialValidation.missingMandatory;
  status = initialValidation.valid ? 'draft' : 'awaiting_fields';
  await persistVersion(
    status,
    {
      correlationId: input.correlationId,
      kind: 'user',
      userId: input.authorUserId,
    },
    initialValidation.errors,
  );

  // Main event loop. Run until the workflow reaches a terminal state and there
  // are no pending signals left to apply.
  while ((status as IncidentStatus) !== 'exported' && (status as IncidentStatus) !== 'rejected') {
    await condition(
      () =>
        pendingDraft !== undefined ||
        pendingSubmit !== undefined ||
        pendingApproval !== undefined ||
        pendingExport !== undefined,
    );

    if (pendingDraft) {
      const draft = pendingDraft;
      pendingDraft = undefined;
      formData = { ...draft.formData };
      const validation = await validateAgainstSchema({
        formData,
        formTemplate: input.formTemplate,
      });
      missingMandatory = validation.missingMandatory;
      const nextStatus: IncidentStatus = validation.valid ? 'draft' : 'awaiting_fields';
      await persistVersion(nextStatus, draft.actor, validation.errors);
    }

    if (pendingSubmit) {
      const submit = pendingSubmit;
      pendingSubmit = undefined;
      const validation = await validateAgainstSchema({
        formData,
        formTemplate: input.formTemplate,
      });
      missingMandatory = validation.missingMandatory;
      if (!validation.valid) {
        status = 'awaiting_fields';
        await persistVersion(status, submit.actor, validation.errors);
        await writeAuditEvent({
          actor: submit.actor,
          eventType: 'incident.submit_rejected_missing_fields',
          homeId: input.homeId,
          incidentId: input.incidentId,
          payload: { missingMandatory: validation.missingMandatory },
          residentId: input.residentId,
          tenantId: input.tenantId,
        });
      } else {
        if (submit.actor.kind === 'system') {
          throw new Error('System actors cannot submit incidents for human approval.');
        }
        const approvalRequirement = await resolveIncidentApprovalRequirement({
          formData,
          formTemplate: input.formTemplate,
        });
        const approvalActor: ApprovalActor = {
          correlationId: submit.actor.correlationId,
          kind: submit.actor.kind,
          userId: submit.actor.userId,
          ...(submit.actor.agentRunId !== undefined ? { agentRunId: submit.actor.agentRunId } : {}),
          ...(submit.actor.promptHash !== undefined ? { promptHash: submit.actor.promptHash } : {}),
        };
        const approvalWorkflowInstanceId = `approval-${input.incidentId}`;
        const approvalWorkflowInput = {
          actor: approvalActor,
          approvalId: input.incidentId,
          homeId: input.homeId,
          requestedByUserId: input.authorUserId,
          requiredRoles: approvalRequirement.requiredRoles,
          signaturesRequired: approvalRequirement.signaturesRequired,
          subjectId: input.incidentId,
          subjectType: 'incident',
          summary:
            typeof formData.summary === 'string'
              ? formData.summary
              : `Incident ${input.incidentId}`,
          tenantId: input.tenantId,
          title: approvalRequirement.safeguarding
            ? 'Safeguarding incident review'
            : 'Incident review',
        } satisfies ApprovalRoutingWorkflowInput;

        if (patched('incident-approval-materialization-v1')) {
          await createApprovalRequest({
            ...approvalWorkflowInput,
            orchestrationName: APPROVAL_WORKFLOW_TYPE,
            runtime: 'temporal',
            workflowId: approvalWorkflowInstanceId,
          });
        }

        status = 'awaiting_approval';
        await persistVersion(status, submit.actor);
        await routeForApproval({
          actor: submit.actor,
          homeId: input.homeId,
          immediateRisk: approvalRequirement.immediateRisk,
          incidentId: input.incidentId,
          residentId: input.residentId,
          safeguarding: approvalRequirement.safeguarding,
          tenantId: input.tenantId,
          version: currentVersion,
        });
        await writeAuditEvent({
          actor: submit.actor,
          eventType: 'incident.routed_for_approval',
          homeId: input.homeId,
          incidentId: input.incidentId,
          payload: {
            immediateRisk: approvalRequirement.immediateRisk,
            requiredRoles: approvalRequirement.requiredRoles,
            safeguarding: approvalRequirement.safeguarding,
            signaturesRequired: approvalRequirement.signaturesRequired,
            version: currentVersion,
          },
          residentId: input.residentId,
          tenantId: input.tenantId,
        });

        const child = await startChild(APPROVAL_WORKFLOW_TYPE, {
          args: [approvalWorkflowInput],
          parentClosePolicy: ParentClosePolicy.ABANDON,
          taskQueue: approvalTaskQueue,
          workflowId: approvalWorkflowInstanceId,
        });
        const approvalResult = (await child.result()) as ApprovalStateQuery;
        if (approvalResult.status === 'pending') {
          throw new Error('Approval child completed without a terminal decision.');
        }
        status = approvalResult.status;
        const terminalSignature = approvalResult.signatures.at(-1);
        const terminalActor: IncidentActor = {
          correlationId: submit.actor.correlationId,
          kind: 'user',
          userId: terminalSignature?.userId ?? submit.actor.userId,
        };
        await persistVersion(status, terminalActor);
        if (status === 'approved' && patched('incident-follow-up-actions-v1')) {
          if (terminalSignature === undefined) {
            throw new Error('Approved Incident follow-ups require a terminal human signer.');
          }
          const followUps = await ensureIncidentFollowUpActions({
            actor: terminalActor,
            homeId: input.homeId,
            immediateRisk: approvalRequirement.immediateRisk,
            incidentId: input.incidentId,
            orchestrationName: INCIDENT_FOLLOW_UP_WORKFLOW_TYPE,
            runtime: 'temporal',
            safeguarding: approvalRequirement.safeguarding,
            tenantId: input.tenantId,
          });
          for (const followUp of followUps) {
            await startChild(INCIDENT_FOLLOW_UP_WORKFLOW_TYPE, {
              args: [
                {
                  actionId: followUp.actionId,
                  attempt: followUp.attempt,
                  correlationId: submit.actor.correlationId,
                  homeId: input.homeId,
                  incidentId: input.incidentId,
                  kind: followUp.kind,
                  requestedByUserId: terminalSignature.userId,
                  targetId: followUp.targetId,
                  tenantId: input.tenantId,
                } satisfies IncidentFollowUpActionWorkflowInput,
              ],
              parentClosePolicy: ParentClosePolicy.ABANDON,
              taskQueue: INCIDENT_FOLLOW_UPS_TASK_QUEUE,
              workflowId: followUp.workflowId,
            });
          }
        }
      }
    }

    if (pendingApproval) {
      const approval = pendingApproval;
      pendingApproval = undefined;
      // Retained for workflow histories created before role-aware approval
      // children; new executions route the legacy endpoint to the child.
      if ((status as IncidentStatus) !== 'awaiting_approval') {
        log.warn('Approve signal ignored: incident is not awaiting approval', {
          status,
          workflowId,
        });
      } else {
        status = 'approved';
        await persistVersion(status, approval.actor);
        await writeAuditEvent({
          actor: approval.actor,
          eventType: 'incident.approved',
          homeId: input.homeId,
          incidentId: input.incidentId,
          payload: { approverUserId: approval.approverUserId, version: currentVersion },
          residentId: input.residentId,
          tenantId: input.tenantId,
        });
      }
    }

    if (pendingExport) {
      const exp = pendingExport;
      pendingExport = undefined;
      if (status !== 'approved') {
        log.warn('Export signal ignored: incident is not approved', {
          status,
          workflowId,
        });
      } else {
        const exported = await exportPdf({
          actor: exp.actor,
          formData,
          formTemplate: input.formTemplate,
          homeId: input.homeId,
          incidentId: input.incidentId,
          residentId: input.residentId,
          tenantId: input.tenantId,
          version: currentVersion,
        });
        exportObjectKey = exported.objectKey;
        status = 'exported';
        await writeAuditEvent({
          actor: exp.actor,
          eventType: 'incident.exported',
          homeId: input.homeId,
          incidentId: input.incidentId,
          payload: {
            objectKey: exported.objectKey,
            sha256: exported.sha256,
            sizeBytes: exported.sizeBytes,
          },
          residentId: input.residentId,
          tenantId: input.tenantId,
        });
      }
    }
  }

  async function persistVersion(
    nextStatus: IncidentStatus,
    actor: IncidentActor,
    validationErrors: readonly { path: string; message: string }[] = [],
  ): Promise<void> {
    currentVersion += 1;
    status = nextStatus;
    await persistIncidentVersion({
      actor,
      authorUserId: input.authorUserId,
      formData,
      formTemplate: input.formTemplate,
      homeId: input.homeId,
      incidentId: input.incidentId,
      missingMandatory,
      residentId: input.residentId,
      status: nextStatus,
      tenantId: input.tenantId,
      validationErrors,
      version: currentVersion,
      workflowId,
    });
  }
}
