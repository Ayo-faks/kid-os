import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0022_durable_retention_idempotency/migration.sql',
  ),
  'utf8',
);

describe('0022 Durable Retention idempotency migration', () => {
  it('adds a nullable execution key without rewriting legacy evidence', () => {
    expect(migration).toContain('ADD COLUMN "execution_key" TEXT');
    expect(migration).not.toMatch(/UPDATE\s+"core"\."retention_runs"/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it('uniquely constrains only new keyed runs', () => {
    expect(migration).toContain('retention_runs_execution_key_key');
    expect(migration).toContain('WHERE "execution_key" IS NOT NULL');
  });
});
