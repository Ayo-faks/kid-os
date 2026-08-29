import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const uuid = z.string().uuid();

export const CreateEmailDraftSchema = z
  .object({
    source: z
      .object({
        kind: z.enum(['incident', 'handover', 'general']),
        id: uuid.optional(),
        summary: z.string().min(10).max(4000),
      })
      .strict(),
    recipient: z
      .object({
        name: z.string().min(1).max(200).optional(),
        email: z.string().email().min(3).max(320),
        role: z.string().min(1).max(80).optional(),
      })
      .strict(),
    instructions: z.string().min(10).max(4000),
  })
  .strict();

export class CreateEmailDraftDto extends createZodDto(CreateEmailDraftSchema) {}

export interface CreateEmailDraftResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'processing';
}
