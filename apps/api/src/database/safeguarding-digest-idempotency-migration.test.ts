import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0023_safeguarding_digest_audit_idempotency/migration.sql',
  ),
  'utf8',
);

describe('0023 Safeguarding digest audit idempotency migration', () => {
  it('uniquely keys only new digest dispatch rows carrying a dispatch key', () => {
    expect(migration).toContain('events_safeguarding_digest_dispatch_key');
    expect(migration).toContain("metadata\" ->> 'dispatch_key'");
    expect(migration).toContain("action\" = 'safeguarding.weekly_digest_dispatched'");
    expect(migration).toContain("metadata\" ? 'dispatch_key'");
  });

  it('does not rewrite append-only legacy audit events', () => {
    expect(migration).not.toMatch(/UPDATE\s+"audit"\."events"/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});
