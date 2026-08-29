import type {
  IncidentActor,
  IncidentFollowUpActionDescriptor,
  IncidentStatus,
} from '@careos/contracts';
import {
  INCIDENT_DURABLE_EVENTS,
  INCIDENT_DURABLE_VERSION,
  INCIDENT_DURABLE_WORKFLOW_TYPE,
  incidentWorkflowId,
} from '@careos/contracts';

import type {
  ApprovalRoutingOrchestratorInput,
  DurableApprovalState,
} from './approval-routing.contracts.js';
import { assertDurableInstanceId } from './payload-policy.js';

export const INCIDENT_ORCHESTRATION_VERSION = INCIDENT_DURABLE_VERSION;
export const INCIDENT_REPORT_ORCHESTRATOR = INCIDENT_DURABLE_WORKFLOW_TYPE;
export const INITIALIZE_INCIDENT_ACTIVITY = 'initializeIncidentFromCommandActivityV1';
export const APPLY_INCIDENT_COMMAND_ACTIVITY = 'applyIncidentCommandActivityV1';
export const RECORD_INCIDENT_APPROVAL_ACTIVITY = 'recordIncidentApprovalResultActivityV1';
export const INCIDENT_COMMAND_EVENT = INCIDENT_DURABLE_EVENTS.command;

export interface IncidentReportOrchestratorInput {
  readonly actor: IncidentActor;
  readonly authorUserId: string;
  readonly formTemplate: {
    readonly templateId: string;
    readonly version: string;
  };
  readonly homeId: string;
  readonly incidentId: string;
  readonly initialCommandId: string;
  readonly residentId: string;
  readonly tenantId: string;
}

export interface IncidentCommandEvent {
  readonly commandId: string;
}

export interface DurableIncidentState {
  readonly currentVersion: number;
  readonly exportObjectKey?: string;
  readonly incidentId: string;
  readonly missingMandatory: readonly string[];
  readonly status: IncidentStatus;
}

export interface ApplyIncidentCommandInput {
  readonly commandId: string;
  readonly currentVersion: number;
  readonly homeId: string;
  readonly incidentId: string;
  readonly status: IncidentStatus;
  readonly tenantId: string;
}

export type ApplyIncidentCommandResult =
  | { readonly kind: 'state'; readonly state: DurableIncidentState }
  | {
      readonly approval: ApprovalRoutingOrchestratorInput;
      readonly kind: 'await_approval';
      readonly state: DurableIncidentState;
    };

export interface RecordIncidentApprovalResultInput {
  readonly approval: DurableApprovalState;
  readonly correlationId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly tenantId: string;
}

export interface RecordIncidentApprovalResultResult {
  readonly followUps: readonly IncidentFollowUpActionDescriptor[];
  readonly state: DurableIncidentState;
}

export function incidentReportInstanceId(incidentId: string): string {
  return assertDurableInstanceId(incidentWorkflowId(incidentId));
}
