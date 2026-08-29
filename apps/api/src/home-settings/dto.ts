import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateSafeguardingContactSchema = z
  .object({
    email: z.string().trim().email().max(320).nullable(),
    name: z.string().trim().min(1).max(120).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.email === null) !== (value.name === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Safeguarding contact name and email must be provided or cleared together.',
        path: [value.name === null ? 'name' : 'email'],
      });
    }
  });

export class UpdateSafeguardingContactDto extends createZodDto(UpdateSafeguardingContactSchema) {}

export interface SafeguardingContactResponse {
  readonly canUpdate: boolean;
  readonly configured: boolean;
  readonly email: string | null;
  readonly name: string | null;
  readonly updatedAt: string;
}
