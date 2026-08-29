import type { HandoverActor } from './handovers-workflow.js';
import type { ValidationError } from './incidents-activities.js';

export interface SummarizeHandoverInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly freeText: string;
  readonly transcriptObjectKey?: string;
  readonly correlationId: string;
  readonly agentRunId?: string;
}

export interface SummarizeHandoverResult {
  readonly formData: Record<string, unknown>;
  readonly summary: string;
  readonly missingMandatory: readonly string[];
  readonly confidence: number;
  readonly promptHash: string;
}

export interface ValidateHandoverInput {
  readonly formData: Record<string, unknown>;
}

export interface ValidateHandoverResult {
  readonly valid: boolean;
  readonly missingMandatory: readonly string[];
  readonly errors: readonly ValidationError[];
}

export interface PersistHandoverInput {
  readonly handoverId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly sourceText: string;
  readonly transcriptObjectKey?: string;
  readonly formData: Record<string, unknown>;
  readonly summary: string;
  readonly authorUserId: string;
  readonly workflowId: string;
  readonly actor: HandoverActor;
}

export interface PersistHandoverResult {
  readonly handoverId: string;
  readonly taskIds: readonly string[];
  readonly nextShiftId?: string;
  readonly assigneeUserIds: readonly string[];
}

export interface DispatchHandoverNotificationsInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly handoverId: string;
  readonly shiftId: string;
  readonly nextShiftId?: string;
  readonly taskIds: readonly string[];
  readonly assigneeUserIds: readonly string[];
  readonly actor: HandoverActor;
}

export interface DispatchHandoverNotificationsResult {
  readonly dispatched: boolean;
  readonly outboxId?: string;
}
