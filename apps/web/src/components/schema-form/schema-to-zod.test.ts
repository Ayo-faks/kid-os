import { loadFormTemplate, type JsonSchema } from '@careos/schemas';
import { describe, expect, it } from 'vitest';
import type { ZodError } from 'zod';

import { jsonSchemaToZod } from './schema-to-zod';

function expectInvalid(result: { success: boolean; error?: ZodError }): ZodError {
  if (result.success) throw new Error('Expected validation failure');
  if (!result.error) throw new Error('Missing zod error');
  return result.error;
}

describe('jsonSchemaToZod', () => {
  const behavioural = loadFormTemplate('incident.behavioural', 'v1').schema;

  it('enforces required fields when enforceRequired is true', () => {
    const zod = jsonSchemaToZod(behavioural, { enforceRequired: true });
    const result = zod.safeParse({});
    const error = expectInvalid(result);
    const paths = error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('residentId');
    expect(paths).toContain('summary');
    expect(paths).toContain('behaviourType');
  });

  it('treats required fields as optional in draft mode', () => {
    const zod = jsonSchemaToZod(behavioural, { enforceRequired: false });
    const result = zod.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates string formats (uuid, date-time) and enums', () => {
    const zod = jsonSchemaToZod(behavioural, { enforceRequired: true });
    const result = zod.safeParse({
      residentId: 'not-a-uuid',
      occurredAt: 'yesterday',
      location: '',
      summary: 'short',
      behaviourType: 'not_in_enum',
      triggers: [],
      responseTaken: 'ok',
      outcomeForResident: 'ok',
    });
    const error = expectInvalid(result);
    const paths = error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('residentId');
    expect(paths).toContain('occurredAt');
    expect(paths).toContain('behaviourType');
  });

  it('accepts a fully valid behavioural payload', () => {
    const zod = jsonSchemaToZod(behavioural, { enforceRequired: true });
    const result = zod.safeParse({
      residentId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-05-17T09:30:00.000Z',
      location: 'Lounge',
      summary: 'Resident expressed frustration after a peer borrowed their headphones.',
      behaviourType: 'verbal_aggression',
      triggers: ['Loud noise'],
      responseTaken: 'Offered quiet space; de-escalation succeeded.',
      physicalInterventionUsed: false,
      outcomeForResident: 'Calm within 10 minutes.',
      witnesses: [],
      safeguardingConcern: false,
      injuries: [],
    });
    expect(result.success).toBe(true);
  });

  it('handles nested array items (repeating groups)', () => {
    const arraySchema: JsonSchema = {
      type: 'object',
      required: ['rows'],
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['who'],
            properties: {
              who: { type: 'string', enum: ['a', 'b'] },
              note: { type: 'string', maxLength: 10 },
            },
          },
        },
      },
    };
    const zod = jsonSchemaToZod(arraySchema, { enforceRequired: true });
    expect(zod.safeParse({ rows: [{ who: 'a' }] }).success).toBe(true);
    expect(zod.safeParse({ rows: [{ who: 'c' }] }).success).toBe(false);
  });
});
