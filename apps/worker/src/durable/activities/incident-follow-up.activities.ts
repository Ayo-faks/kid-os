import { emailDraftWorkflowId, type IncidentActor } from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { resolveApprovalRequirementActivity } from '../../activities/approvals.js';
import {
  dispatchEmailDraftNotifications,
  persistEmailDraft,
  validateEmailDraft,
} from '../../activities/email-drafts.js';
import {
  composeExportBundle,
  markExportBundleBuilding,
  markExportBundleFailed,
  markExportBundleReady,
} from '../../activities/export-bundles.js';
import {
  ensureFollowUpExportBundle,
  loadSafeguardingContact,
  transitionIncidentFollowUp,
} from '../../activities/incident-follow-ups.js';
import { withTenantContext } from '../../db/pg.js';
import {
  APPROVAL_ORCHESTRATION_VERSION,
  APPROVAL_ROUTING_ORCHESTRATOR,
  type ApprovalRoutingOrchestratorInput,
  approvalRoutingInstanceId,
} from '../approval-routing.contracts.js';
import {
  INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
  INCIDENT_FOLLOW_UP_ORCHESTRATOR,
  type FinalizeIncidentFollowUpInput,
  type IncidentFollowUpOrchestratorInput,
  type ProcessIncidentFollowUpResult,
  type StartIncidentFollowUpInput,
} from '../incident-follow-up.contracts.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

export async function processIncidentFollowUpActionActivity(
  _context: ActivityContext,
  input: IncidentFollowUpOrchestratorInput,
): Promise<ProcessIncidentFollowUpResult> {
  const actor = systemActor(input.correlationId);
  await transitionIncidentFollowUp({
    actionId: input.actionId,
    actor,
    homeId: input.homeId,
    status: 'running',
    tenantId: input.tenantId,
  });

  try {
    if (input.kind === 'safeguarding_email') {
      return await prepareSafeguardingEmail(input, actor);
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
    await markExportBundleBuilding({
      actor,
      bundleId: input.targetId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });
    const composed = await composeExportBundle({
      actor,
      bundleId: input.targetId,
      homeId: input.homeId,
      incidentId: input.incidentId,
      tenantId: input.tenantId,
    });
    await markExportBundleReady({
      actor,
      bundleId: input.targetId,
      homeId: input.homeId,
      manifestSha256: composed.manifestSha256,
      objectKey: composed.objectKey,
      retainUntilIso: composed.retainUntilIso,
      signature: composed.signature,
      signatureAlgorithm: composed.signatureAlgorithm,
      sizeBytes: composed.sizeBytes,
      tenantId: input.tenantId,
    });
    return { kind: 'terminal', status: 'completed' };
  } catch {
    throw new Error(`Incident follow-up ${input.kind} processing failed.`);
  }
}

export async function finalizeIncidentFollowUpActionActivity(
  _context: ActivityContext,
  input: FinalizeIncidentFollowUpInput,
): Promise<void> {
  const actor = systemActor(input.correlationId);
  if (input.kind === 'export_bundle' && input.status === 'failed') {
    await markExportBundleFailed({
      actor,
      bundleId: input.targetId,
      homeId: input.homeId,
      reason: 'Incident follow-up export processing failed.',
      tenantId: input.tenantId,
    });
  }
  await transitionIncidentFollowUp({
    actionId: input.actionId,
    actor,
    ...(input.failureCode === undefined
      ? {}
      : {
          failureCode: input.failureCode,
          failureReason:
            input.failureCode === 'safeguarding-contact-not-configured'
              ? 'Configure a safeguarding contact for this home, then retry.'
              : 'The incident follow-up action failed after retries.',
        }),
    homeId: input.homeId,
    status: input.status,
    targetId: input.targetId,
    tenantId: input.tenantId,
  });
  await withTenantContext(
    { actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE workflow_kind = 'incident-follow-up'
            AND subject_type = 'incident_follow_up_action'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [input.actionId, input.status === 'failed' ? 'failed' : 'completed'],
      );
    },
  );
}

export function createStartIncidentFollowUpActionActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartIncidentFollowUpInput) => Promise<string> {
  return (_context, input) => {
    const { workflowId, ...orchestrationInput } = input;
    assertDurableInstanceId(workflowId);
    assertDurablePayload(orchestrationInput, 'incidentFollowUp');
    return scheduleDurableOrchestrationIdempotently(
      client,
      INCIDENT_FOLLOW_UP_ORCHESTRATOR,
      orchestrationInput,
      {
        instanceId: workflowId,
        version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
      },
    );
  };
}

export function createStartApprovalActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: ApprovalRoutingOrchestratorInput) => Promise<string> {
  return (_context, input) => {
    const instanceId = approvalRoutingInstanceId(input.approvalId);
    assertDurablePayload(input, 'incidentFollowUpApproval');
    return scheduleDurableOrchestrationIdempotently(client, APPROVAL_ROUTING_ORCHESTRATOR, input, {
      instanceId,
      version: APPROVAL_ORCHESTRATION_VERSION,
    });
  };
}

async function prepareSafeguardingEmail(
  input: IncidentFollowUpOrchestratorInput,
  actor: IncidentActor,
): Promise<ProcessIncidentFollowUpResult> {
  const contact = await loadSafeguardingContact({
    actionId: input.actionId,
    actor,
    homeId: input.homeId,
    tenantId: input.tenantId,
  });
  if (!contact.configured || contact.email === undefined || contact.name === undefined) {
    return { kind: 'terminal', status: 'needs_configuration' };
  }

  const subject = 'Safeguarding incident review';
  const body = `Please review approved safeguarding incident ${input.incidentId} in CareOS. Case details remain in the secure incident record. No external agency has been contacted automatically.`;
  const recipient = {
    email: contact.email,
    name: contact.name,
    role: 'safeguarding_contact',
  } as const;
  const formData = {
    body,
    recipient,
    sensitivity: 'sensitive',
    sensitivity_reasons: ['safeguarding'],
    subject,
  };
  const validation = await validateEmailDraft({ formData });
  if (!validation.valid) throw new Error('Prepared safeguarding email failed validation.');

  const requirement = await resolveApprovalRequirementActivity({
    context: { sensitivity: 'sensitive' },
    skill: 'draft_email',
  });
  if (requirement.signaturesRequired !== 1 && requirement.signaturesRequired !== 2) {
    throw new Error('Safeguarding email must require human approval.');
  }
  await persistEmailDraft({
    actor,
    authorUserId: input.requestedByUserId,
    body,
    emailDraftId: input.targetId,
    homeId: input.homeId,
    recipient,
    sensitivity: 'sensitive',
    sensitivityReasons: ['safeguarding'],
    source: {
      id: input.incidentId,
      kind: 'incident',
      summary: `Approved safeguarding incident ${input.incidentId}`,
    },
    status: 'needs_review',
    subject,
    tenantId: input.tenantId,
    workflowId: emailDraftWorkflowId(input.targetId),
  });
  await dispatchEmailDraftNotifications({
    actor,
    emailDraftId: input.targetId,
    homeId: input.homeId,
    sensitivity: 'sensitive',
    status: 'needs_review',
    tenantId: input.tenantId,
  });

  return {
    approval: {
      actor,
      approvalId: input.targetId,
      homeId: input.homeId,
      requestedByUserId: input.requestedByUserId,
      requiredRoles: requirement.requiredRoles,
      signaturesRequired: requirement.signaturesRequired,
      subjectId: input.targetId,
      subjectType: 'email_draft',
      tenantId: input.tenantId,
    },
    kind: 'await_approval',
  };
}

function systemActor(correlationId: string): IncidentActor {
  return { correlationId, kind: 'system', userId: null };
}
