import type {
  IncidentFollowUpActionDescriptor,
  IncidentFollowUpStatus,
  PostApprovalActionKind,
} from '@careos/contracts';

import type { ApprovalRoutingOrchestratorInput } from './approval-routing.contracts.js';
import { assertDurableInstanceId } from './payload-policy.js';

export const INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION = '1.0.0';
export const INCIDENT_FOLLOW_UP_ORCHESTRATOR = 'IncidentFollowUpActionOrchestratorV1';
export const PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY = 'processIncidentFollowUpActionActivityV1';
export const FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY = 'finalizeIncidentFollowUpActionActivityV1';
export const START_INCIDENT_FOLLOW_UP_ACTIVITY = 'startIncidentFollowUpActionActivityV1';
export const START_FOLLOW_UP_APPROVAL_ACTIVITY = 'startIncidentFollowUpApprovalActivityV1';

export interface IncidentFollowUpOrchestratorInput {
  readonly actionId: string;
  readonly attempt: number;
  readonly correlationId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly kind: PostApprovalActionKind;
  readonly requestedByUserId: string;
  readonly targetId: string;
  readonly tenantId: string;
}

export interface StartIncidentFollowUpInput extends IncidentFollowUpOrchestratorInput {
  readonly workflowId: string;
}

export type ProcessIncidentFollowUpResult =
  | {
      readonly approval: ApprovalRoutingOrchestratorInput;
      readonly kind: 'await_approval';
    }
  | {
      readonly kind: 'terminal';
      readonly status: 'completed' | 'needs_configuration';
    };

export interface FinalizeIncidentFollowUpInput {
  readonly actionId: string;
  readonly correlationId: string;
  readonly failureCode?:
    | 'incident-follow-up-processing-failed'
    | 'safeguarding-contact-not-configured';
  readonly homeId: string;
  readonly kind: PostApprovalActionKind;
  readonly status: IncidentFollowUpStatus;
  readonly targetId: string;
  readonly tenantId: string;
}

export interface DurableIncidentFollowUpState {
  readonly actionId: string;
  readonly status: IncidentFollowUpStatus;
  readonly targetId?: string;
}

export function followUpInputFromDescriptor(
  action: IncidentFollowUpActionDescriptor,
  context: {
    readonly correlationId: string;
    readonly homeId: string;
    readonly incidentId: string;
    readonly requestedByUserId: string;
    readonly tenantId: string;
  },
): StartIncidentFollowUpInput {
  assertDurableInstanceId(action.workflowId);
  return {
    actionId: action.actionId,
    attempt: action.attempt,
    correlationId: context.correlationId,
    homeId: context.homeId,
    incidentId: context.incidentId,
    kind: action.kind,
    requestedByUserId: context.requestedByUserId,
    targetId: action.targetId,
    tenantId: context.tenantId,
    workflowId: action.workflowId,
  };
}
