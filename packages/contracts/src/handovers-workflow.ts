// Shared contract between the API Temporal client and the worker handover
// workflow. Kept dependency-free for both NestJS and Temporal worker imports.

export const HANDOVER_WORKFLOW_TYPE = 'HandoverWorkflow';
export const HANDOVER_DURABLE_WORKFLOW_TYPE = 'HandoverOrchestratorV1';
export const HANDOVER_DURABLE_VERSION = '1.0.0';

export const HANDOVER_QUERIES = {
  getState: 'getState',
} as const;

export type HandoverStatus = 'processing' | 'completed' | 'failed';

export interface HandoverActor {
  readonly kind: 'user' | 'agent';
  readonly userId: string | null;
  readonly correlationId: string;
  readonly agentRunId?: string;
  readonly promptHash?: string;
}

export interface HandoverWorkflowInput {
  readonly handoverId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly freeText: string;
  readonly transcriptObjectKey?: string;
  readonly authorUserId: string;
  readonly correlationId: string;
}

export interface HandoverDurableWorkflowInput {
  readonly actor: HandoverActor;
  readonly authorUserId: string;
  readonly commandId: string;
  readonly handoverId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly tenantId: string;
}

export interface HandoverStateQuery {
  readonly status: HandoverStatus;
  readonly handoverId: string;
  readonly taskIds: readonly string[];
  readonly missingMandatory: readonly string[];
}

export function handoverWorkflowId(handoverId: string): string {
  return `handover-${handoverId}`;
}
