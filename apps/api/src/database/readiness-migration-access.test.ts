import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0016_phase4_readiness_migration_access/migration.sql',
  ),
  'utf8',
);

describe('0016 readiness migration access', () => {
  it('grants the app role read-only access to Prisma migration metadata', () => {
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "public"."_prisma_migrations" TO "careos_app"',
    );
    expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)/i);
  });
});
