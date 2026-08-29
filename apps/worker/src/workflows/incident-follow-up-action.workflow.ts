import {
  EMAIL_DRAFTS_TASK_QUEUE,
  EMAIL_DRAFT_WORKFLOW_TYPE,
  EXPORT_BUNDLES_TASK_QUEUE,
  SERIOUS_INCIDENT_EXPORT_WORKFLOW_TYPE,
  emailDraftWorkflowId,
  type EmailDraftWorkflowInput,
  type IncidentActor,
  type IncidentFollowUpActionWorkflowInput,
  type IncidentFollowUpActionWorkflowResult,
  type SeriousIncidentExportWorkflowInput,
} from '@careos/contracts/workflow';
import { ParentClosePolicy, proxyActivities, startChild } from '@temporalio/workflow';

import type * as followUpActivities from '../activities/incident-follow-ups.js';

const { ensureFollowUpExportBundle, loadSafeguardingContact, transitionIncidentFollowUp } =
  proxyActivities<typeof followUpActivities>({
    retry: { initialInterval: '1 second', maximumAttempts: 5 },
    startToCloseTimeout: '30 seconds',
  });

export async function IncidentFollowUpActionWorkflow(
  input: IncidentFollowUpActionWorkflowInput,
): Promise<IncidentFollowUpActionWorkflowResult> {
  const actor: IncidentActor = {
    correlationId: input.correlationId,
    kind: 'system',
    userId: null,
  };
  await transitionIncidentFollowUp({
    actionId: input.actionId,
    actor,
    homeId: input.homeId,
    status: 'running',
    tenantId: input.tenantId,
  });

  try {
    if (input.kind === 'safeguarding_email') {
      const contact = await loadSafeguardingContact({
        actionId: input.actionId,
        actor,
        homeId: input.homeId,
        tenantId: input.tenantId,
      });
      if (!contact.configured || contact.email === undefined || contact.name === undefined) {
        await transitionIncidentFollowUp({
          actionId: input.actionId,
          actor,
          failureCode: 'safeguarding-contact-not-configured',
          failureReason: 'Configure a safeguarding contact for this home, then retry.',
          homeId: input.homeId,
          status: 'needs_configuration',
          tenantId: input.tenantId,
        });
        return { actionId: input.actionId, status: 'needs_configuration' };
      }

      const child = await startChild(EMAIL_DRAFT_WORKFLOW_TYPE, {
        args: [
          {
            actor,
            authorUserId: input.requestedByUserId,
            correlationId: input.correlationId,
            emailDraftId: input.targetId,
            homeId: input.homeId,
            instructions:
              'Draft a factual safeguarding notification for human review. Do not claim it was sent, approved, or delivered.',
            preparedDraft: {
              body: `Please review approved safeguarding incident ${input.incidentId} in CareOS. Case details remain in the secure incident record. No external agency has been contacted automatically.`,
              sensitivity: 'sensitive',
              sensitivityReasons: ['safeguarding'],
              subject: 'Safeguarding incident review',
            },
            recipient: {
              email: contact.email,
              name: contact.name,
              role: 'safeguarding_contact',
            },
            source: {
              id: input.incidentId,
              kind: 'incident',
              summary: `Approved safeguarding incident ${input.incidentId}`,
            },
            tenantId: input.tenantId,
          } satisfies EmailDraftWorkflowInput,
        ],
        parentClosePolicy: ParentClosePolicy.ABANDON,
        taskQueue: input.emailDraftsTaskQueue ?? EMAIL_DRAFTS_TASK_QUEUE,
        workflowId: emailDraftWorkflowId(input.targetId),
      });
      await child.result();
      await transitionIncidentFollowUp({
        actionId: input.actionId,
        actor,
        homeId: input.homeId,
        status: 'awaiting_approval',
        targetId: input.targetId,
        tenantId: input.tenantId,
      });
      return { actionId: input.actionId, status: 'awaiting_approval', targetId: input.targetId };
    }

    const bundleWorkflowId = `serious-incident-export-${input.targetId}`;
    await ensureFollowUpExportBundle({
      actionId: input.actionId,
      actor,
      bundleId: input.targetId,
      homeId: input.homeId,
      incidentId: input.incidentId,
      requestedByUserId: input.requestedByUserId,
      tenantId: input.tenantId,
      workflowId: bundleWorkflowId,
    });
    const child = await startChild(SERIOUS_INCIDENT_EXPORT_WORKFLOW_TYPE, {
      args: [
        {
          actor,
          bundleId: input.targetId,
          homeId: input.homeId,
          incidentId: input.incidentId,
          tenantId: input.tenantId,
        } satisfies SeriousIncidentExportWorkflowInput,
      ],
      parentClosePolicy: ParentClosePolicy.ABANDON,
      taskQueue: input.exportBundlesTaskQueue ?? EXPORT_BUNDLES_TASK_QUEUE,
      workflowId: bundleWorkflowId,
    });
    const result = (await child.result()) as { readonly status: 'ready' | 'failed' };
    const status = result.status === 'ready' ? 'completed' : 'failed';
    await transitionIncidentFollowUp({
      actionId: input.actionId,
      actor,
      ...(status === 'failed'
        ? { failureCode: 'export-bundle-failed', failureReason: 'Signed bundle generation failed.' }
        : {}),
      homeId: input.homeId,
      status,
      targetId: input.targetId,
      tenantId: input.tenantId,
    });
    return { actionId: input.actionId, status, targetId: input.targetId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'incident-follow-up-failed';
    await transitionIncidentFollowUp({
      actionId: input.actionId,
      actor,
      failureCode: 'workflow-failed',
      failureReason: reason,
      homeId: input.homeId,
      status: 'failed',
      tenantId: input.tenantId,
    });
    return { actionId: input.actionId, status: 'failed' };
  }
}
