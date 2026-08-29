import { describe, expect, it } from 'vitest';

import { formatDocumentDateTime } from './DocumentsPanel';

describe('formatDocumentDateTime', () => {
  it('formats timestamps deterministically in Europe/London across daylight saving', () => {
    expect(formatDocumentDateTime('2026-01-16T10:00:00.000Z')).toBe('16 Jan 2026, 10:00');
    expect(formatDocumentDateTime('2026-07-16T10:00:00.000Z')).toBe('16 Jul 2026, 11:00');
  });
});
