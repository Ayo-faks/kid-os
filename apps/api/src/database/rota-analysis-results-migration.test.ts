import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0021_durable_rota_analysis_results/migration.sql',
  ),
  'utf8',
);

describe('0021 Durable Rota Analysis results migration', () => {
  it('stores results under forced tenant-home RLS', () => {
    expect(migration).toContain('CREATE TABLE "core"."rota_analysis_results"');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('rota_analysis_results_tenant_home_isolation');
  });

  it('requires completed rows to contain a JSON object and failed rows to carry a code', () => {
    expect(migration).toContain('rota_analysis_results_terminal_shape_check');
    expect(migration).toContain('jsonb_typeof("result") = \'object\'');
    expect(migration).toContain('"failure_code" IS NOT NULL');
  });

  it('audits counts and status without copying the result payload', () => {
    const auditFunction = migration.slice(migration.indexOf('on_rota_analysis_result_change'));
    expect(auditFunction).toContain("'gap_count'");
    expect(auditFunction).toContain("'proposal_count'");
    expect(auditFunction).not.toContain("'result', NEW.result");
    expect(auditFunction).not.toContain("'narration'");
  });
});
