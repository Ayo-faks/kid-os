import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RecentAutomationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export class RecentAutomationsQueryDto extends createZodDto(RecentAutomationsQuerySchema) {}

export const AUTOMATION_ACTIONS = [
  'shift.reminder_dispatched',
  'shift.handover_due_reminder_dispatched',
  'incident.missing_fields_reminder_dispatched',
  'safeguarding.weekly_digest_dispatched',
] as const;

export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export interface RecentAutomationEvent {
  readonly id: string;
  readonly action: AutomationAction;
  readonly occurredAt: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly correlationId: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface RecentAutomationsResponse {
  readonly events: readonly RecentAutomationEvent[];
}
