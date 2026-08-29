import { describe, expect, it } from 'vitest';

import { UpsertRetentionPolicySchema } from './dto.js';

describe('UpsertRetentionPolicySchema', () => {
  it('accepts verified object deletion for attachments', () => {
    expect(
      UpsertRetentionPolicySchema.safeParse({
        action: 'object_delete',
        record_type: 'attachment',
        retention_days: 30,
      }).success,
    ).toBe(true);
  });

  it('rejects the retired crypto_shred action', () => {
    expect(
      UpsertRetentionPolicySchema.safeParse({
        action: 'crypto_shred',
        record_type: 'attachment',
        retention_days: 30,
      }).success,
    ).toBe(false);
  });

  it('rejects object deletion for database-only record types', () => {
    const result = UpsertRetentionPolicySchema.safeParse({
      action: 'object_delete',
      record_type: 'incident',
      retention_days: 30,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/only valid for attachments/i);
    }
  });
});
