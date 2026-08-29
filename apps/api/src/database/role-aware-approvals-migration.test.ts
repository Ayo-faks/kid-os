import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0015_phase4_role_aware_approvals/migration.sql',
  ),
  'utf8',
);

describe('0015 role-aware approvals migration', () => {
  it('constrains subjects, role coverage, and signature payloads', () => {
    expect(migration).toContain("subject_type\" IN ('email_draft', 'incident')");
    expect(migration).toContain('approval_required_roles_valid');
    expect(migration).toContain('approval_signatures_valid');
    expect(migration).not.toMatch(/CHECK[\s\S]{0,300}SELECT DISTINCT/);
  });

  it('backfills dual-sign-off rows to manager and safeguarding lead', () => {
    expect(migration).toContain("ARRAY['manager', 'safeguarding_lead']::text[]");
    expect(migration).toContain("ARRAY['manager']::text[]");
  });
});
