// Shared contract between the API (Temporal client) and the worker
// (workflow definition, lands in Phase 1 §5). Kept dependency-free so the
// worker package can import it without pulling in NestJS.

export const INCIDENT_WORKFLOW_TYPE = 'IncidentReportWorkflow';
export const INCIDENT_DURABLE_WORKFLOW_TYPE = 'IncidentReportOrchestratorV1';
export const INCIDENT_DURABLE_VERSION = '1.0.0';

export const INCIDENT_DURABLE_EVENTS = {
  command: 'incidentCommand',
} as const;

export const INCIDENT_SIGNALS = {
  approve: 'approve',
  exportPdf: 'exportPdf',
  submitForApproval: 'submitForApproval',
  updateDraft: 'updateDraft',
} as const;

export const INCIDENT_QUERIES = {
  getState: 'getState',
} as const;

export type IncidentSignalName = (typeof INCIDENT_SIGNALS)[keyof typeof INCIDENT_SIGNALS];
export type IncidentQueryName = (typeof INCIDENT_QUERIES)[keyof typeof INCIDENT_QUERIES];

export type IncidentStatus =
  | 'draft'
  | 'awaiting_fields'
  | 'awaiting_approval'
  | 'approved'
  | 'exported'
  | 'rejected';

export interface IncidentActor {
  readonly kind: 'user' | 'agent' | 'system';
  readonly userId: string | null;
  readonly correlationId: string;
  readonly agentRunId?: string;
  readonly promptHash?: string;
}

export interface IncidentReportWorkflowInput {
  readonly incidentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly residentId: string;
  readonly formTemplate: {
    readonly templateId: string;
    readonly version: string;
  };
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly approvalTaskQueue?: string;
  readonly initialFormData?: Record<string, unknown>;
}

export interface UpdateDraftSignal {
  readonly formData: Record<string, unknown>;
  readonly actor: IncidentActor;
}

export interface SubmitForApprovalSignal {
  readonly actor: IncidentActor;
}

export interface ApproveSignal {
  readonly approverUserId: string;
  readonly actor: IncidentActor;
}

export interface ExportSignal {
  readonly actor: IncidentActor;
}

export interface IncidentStateQuery {
  readonly status: IncidentStatus;
  readonly currentVersion: number;
  readonly missingMandatory: readonly string[];
  readonly formData: Record<string, unknown>;
  readonly exportObjectKey?: string;
}

export function incidentWorkflowId(incidentId: string): string {
  return `incident-${incidentId}`;
}
