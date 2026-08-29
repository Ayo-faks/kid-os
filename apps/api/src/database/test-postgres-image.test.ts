import { describe, expect, it } from 'vitest';

import {
  CAREOS_TEST_POSTGRES_IMAGE,
  resolveCareosTestPostgresImage,
} from './test-postgres-image.js';

describe('Testcontainers PostgreSQL image', () => {
  it('uses the reviewed digest when no override is present', () => {
    expect(resolveCareosTestPostgresImage({})).toBe(CAREOS_TEST_POSTGRES_IMAGE);
  });

  it('accepts only an exact reviewed override', () => {
    expect(
      resolveCareosTestPostgresImage({
        CAREOS_TEST_POSTGRES_IMAGE,
      }),
    ).toBe(CAREOS_TEST_POSTGRES_IMAGE);
  });

  it.each([
    'pgvector/pgvector:pg16',
    'pgvector/pgvector:pg16@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('rejects unreviewed override %s', (image) => {
    expect(() => resolveCareosTestPostgresImage({ CAREOS_TEST_POSTGRES_IMAGE: image })).toThrow(
      /reviewed digest-pinned pgvector image/,
    );
  });
});
