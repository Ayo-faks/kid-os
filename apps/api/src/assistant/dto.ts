import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const QUICK_ACTION_IDS = [
  'create_incident',
  'notify_safeguarding',
  'update_behaviour_log',
] as const;
export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];

export const AssistantMessageSchema = z.object({
  message: z.string().min(1).max(4000),
  quickActionId: z.enum(QUICK_ACTION_IDS).optional(),
  residentId: z.string().uuid().optional(),
});
export class AssistantMessageDto extends createZodDto(AssistantMessageSchema) {}

export type AssistantMessageInput = z.infer<typeof AssistantMessageSchema>;
