import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0014_phase4_secure_report_view/migration.sql',
  ),
  'utf8',
);

describe('0014 secure report view migration', () => {
  it('uses invoker security so underlying RLS remains authoritative', () => {
    expect(migrationSql).toMatch(
      /CREATE OR REPLACE VIEW "core"\."v_incidents_reportable"\s+WITH \(security_invoker = true\)/,
    );
  });

  it('derives incident type from form_templates and excludes soft-deleted incidents', () => {
    expect(migrationSql).toContain('LEFT JOIN "core"."form_templates" ft');
    expect(migrationSql).toContain("NULLIF(ft.template_id, '')");
    expect(migrationSql).toContain('WHERE i.soft_deleted_at IS NULL');
    expect(migrationSql).not.toContain("form_data ->> 'incident_type'");
  });
});
