import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const AnalyzeRotaSchema = z
  .object({
    period_start: isoDateTime,
    period_end: isoDateTime,
  })
  .strict()
  .refine((value) => value.period_start < value.period_end, {
    message: 'period_end must be after period_start.',
    path: ['period_end'],
  });

export class AnalyzeRotaDto extends createZodDto(AnalyzeRotaSchema) {}

export const PublishRotaSchema = z
  .object({
    period_start: isoDateTime,
    period_end: isoDateTime,
    shift_ids: z.array(uuid).min(1).max(200),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine((value) => value.period_start < value.period_end, {
    message: 'period_end must be after period_start.',
    path: ['period_end'],
  });

export class PublishRotaDto extends createZodDto(PublishRotaSchema) {}

export const RotaRuleKindSchema = z.enum(['min_staffing', 'gender_mix', 'qualification_flag']);

export const CreateRotaRuleSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: RotaRuleKindSchema,
    parameters: z.record(z.unknown()),
    active: z.boolean().optional(),
  })
  .strict();

export class CreateRotaRuleDto extends createZodDto(CreateRotaRuleSchema) {}

export interface RotaGapResponse {
  readonly shiftId: string;
  readonly kind: 'min_staffing' | 'gender_mix' | 'qualification_flag';
  readonly ruleId: string | null;
  readonly ruleName: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly detail: string;
}

export interface RotaProposalResponse {
  readonly shiftId: string;
  readonly addUserIds: readonly string[];
  readonly removeUserIds: readonly string[];
  readonly reason: string;
  readonly resolvedGapKinds: readonly RotaGapResponse['kind'][];
}

export interface RotaShiftResponse {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedUserIds: readonly string[];
}

export interface AnalyzeRotaResponse {
  readonly correlationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shifts: readonly RotaShiftResponse[];
  readonly gaps: readonly RotaGapResponse[];
  readonly proposals: readonly RotaProposalResponse[];
  readonly narration: string;
}

export interface PublishRotaResponse {
  readonly publicationId: string;
  readonly workflowId: string;
  readonly status: 'processing';
}

export interface RotaRuleResponse {
  readonly id: string;
  readonly name: string;
  readonly kind: RotaGapResponse['kind'];
  readonly parameters: Record<string, unknown>;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RotaOverviewResponse {
  readonly shifts: readonly RotaShiftResponse[];
  readonly rules: readonly RotaRuleResponse[];
}
