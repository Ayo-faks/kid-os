import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const uuid = z.string().uuid();

export const CreateHandoverSchema = z
  .object({
    free_text: z.string().min(10).max(8000),
    shift_id: uuid,
    transcript_object_key: z.string().min(1).max(1024).optional(),
  })
  .strict();
export class CreateHandoverDto extends createZodDto(CreateHandoverSchema) {}

export interface CreateHandoverResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'processing';
}
