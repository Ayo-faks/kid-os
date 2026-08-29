import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { resolveOverviewRange } from './rota.controller.js';

describe('resolveOverviewRange', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');

  it('defaults a bare overview request to seven days from the current UTC day', () => {
    expect(resolveOverviewRange({}, now)).toEqual({
      from: '2026-07-17T00:00:00.000Z',
      to: '2026-07-24T00:00:00.000Z',
    });
  });

  it('preserves explicit valid bounds', () => {
    expect(
      resolveOverviewRange(
        { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        now,
      ),
    ).toEqual({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  });

  it('rejects reversed bounds', () => {
    expect(() =>
      resolveOverviewRange(
        { from: '2026-08-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it.each([{ from: '2026-07-01T00:00:00.000Z' }, { to: '2026-08-01T00:00:00.000Z' }])(
    'rejects a partial range: %o',
    (range) => {
      expect(() => resolveOverviewRange(range, now)).toThrow(BadRequestException);
    },
  );
});
