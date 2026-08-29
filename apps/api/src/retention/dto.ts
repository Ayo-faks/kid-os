import type { RetentionAction, RetentionRecordType } from '@careos/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const recordTypes = [
  'incident',
  'handover_record',
  'email_draft',
  'attachment',
] as const satisfies readonly RetentionRecordType[];

const actions = ['soft_delete', 'object_delete'] as const satisfies readonly RetentionAction[];

export const UpsertRetentionPolicySchema = z
  .object({
    record_type: z.enum(recordTypes),
    retention_days: z.number().int().min(0).max(36500),
    action: z.enum(actions),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'object_delete' && value.record_type !== 'attachment') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'object_delete is only valid for attachments.',
        path: ['action'],
      });
    }
  });

export class UpsertRetentionPolicyDto extends createZodDto(UpsertRetentionPolicySchema) {}

export interface RetentionPolicyResponse {
  readonly id: string;
  readonly recordType: RetentionRecordType;
  readonly retentionDays: number;
  readonly action: RetentionAction;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RetentionPoliciesResponse {
  readonly policies: readonly RetentionPolicyResponse[];
}

export interface RetentionRunResponse {
  readonly action: RetentionAction;
  readonly affectedCount: number;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly id: string;
  readonly recordType: RetentionRecordType;
  readonly scannedCount: number;
  readonly startedAt: string;
  readonly workflowId: string;
}

export interface RetentionRunsResponse {
  readonly runs: readonly RetentionRunResponse[];
}

export const TriggerRetentionSweepSchema = z
  .object({
    correlationId: z.string().min(1).max(128).optional(),
  })
  .strict();

export class TriggerRetentionSweepDto extends createZodDto(TriggerRetentionSweepSchema) {}
