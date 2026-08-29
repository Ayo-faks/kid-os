import { describe, expect, it } from 'vitest';

import {
  assertDurableInstanceId,
  assertDurablePayload,
  MAX_DURABLE_PAYLOAD_BYTES,
} from './payload-policy.js';

describe('Durable payload policy', () => {
  it('accepts opaque workflow identifiers and operational metadata', () => {
    expect(() =>
      assertDurablePayload(
        {
          correlationId: 'corr-1',
          homeId: '22222222-2222-4222-8222-222222222222',
          minLookaheadMinutes: 25,
          shiftId: '33333333-3333-4333-8333-333333333333',
          tenantId: '11111111-1111-4111-8111-111111111111',
        },
        'shiftReminder',
      ),
    ).not.toThrow();
  });

  it.each([
    'freeText',
    'form_data',
    'instructions',
    'message',
    'note',
    'reason',
    'residentName',
    'summary',
    'title',
    'extracted-text',
  ])('rejects resident-content field %s', (field) => {
    expect(() => assertDurablePayload({ [field]: 'sensitive' }, 'workflow')).toThrow(
      /forbidden in Durable Task payloads/,
    );
  });

  it('rejects payloads over the conservative scheduler budget', () => {
    expect(() =>
      assertDurablePayload({ opaque: 'x'.repeat(MAX_DURABLE_PAYLOAD_BYTES) }, 'workflow'),
    ).toThrow(/exceeds/);
  });
});

describe('Durable instance ID policy', () => {
  it('accepts a printable opaque ID at the service limit', () => {
    const id = `workflow:${'a'.repeat(91)}`;
    expect(assertDurableInstanceId(id)).toBe(id);
  });

  it.each([
    ['', /length/],
    ['a'.repeat(101), /length/],
    ['@entity-reserved', /reserved/],
    ['workflow:\nunsafe', /printable ASCII/],
    ['workflow:non-ascii-£', /printable ASCII/],
  ] as const)('rejects invalid instance ID %j', (id, expected) => {
    expect(() => assertDurableInstanceId(id)).toThrow(expected);
  });
});
