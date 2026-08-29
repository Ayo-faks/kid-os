import type { ApprovalRole, ApprovalSubjectType } from '@careos/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ApprovalDecisionSchema = z
  .object({
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export class ApprovalDecisionDto extends createZodDto(ApprovalDecisionSchema) {}

export interface ApprovalQueueItemResponse {
  readonly id: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requestedByUserId: string;
  readonly createdAt: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly coveredRoles: readonly ApprovalRole[];
  readonly missingRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 1 | 2;
  readonly signaturesRecorded: number;
  readonly currentUserHasSigned: boolean;
  readonly signedByUserIds: readonly string[];
  readonly signedRoles: readonly string[];
  readonly emailDraft: {
    readonly recipientEmail: string;
    readonly subject: string;
    readonly sensitivity: 'routine' | 'sensitive';
    readonly status: string;
  } | null;
  readonly incident: {
    readonly residentId: string;
    readonly residentName: string;
    readonly status: string;
    readonly templateId: string;
  } | null;
}

export interface ApprovalQueueResponse {
  readonly items: readonly ApprovalQueueItemResponse[];
}

export interface ApprovalDecisionResponse {
  readonly accepted: true;
  readonly workflowId: string;
}
