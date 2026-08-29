import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0020_workflow_runtime_commands/migration.sql',
  ),
  'utf8',
);

describe('workflow runtime command migration', () => {
  it('creates an ownership registry and idempotent command inbox', () => {
    expect(migration).toContain('CREATE TABLE "core"."workflow_instances"');
    expect(migration).toContain('CREATE TABLE "core"."workflow_commands"');
    expect(migration).toContain('workflow_instances_subject_key');
    expect(migration).toContain('workflow_commands_dedupe_key');
    expect(migration).toContain('length("instance_id") BETWEEN 1 AND 100');
  });

  it('enforces tenant and home RLS on both tables', () => {
    expect(migration).toContain('ALTER TABLE "core"."workflow_instances" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "core"."workflow_commands" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('workflow_instances_tenant_home_isolation');
    expect(migration).toContain('workflow_commands_tenant_home_isolation');
    expect(migration.match(/current_setting\('app\.current_tenant_id'/g)).toHaveLength(4);
    expect(migration.match(/current_setting\('app\.current_home_id'/g)).toHaveLength(4);
  });

  it('audits lifecycle metadata without copying command payloads', () => {
    const auditFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION "audit"."on_workflow_command_change"'),
      migration.indexOf('CREATE TRIGGER "workflow_commands_audit_ins"'),
    );
    expect(auditFunction).toContain('workflow.command_recorded');
    expect(auditFunction).toContain('workflow.command_status_changed');
    expect(auditFunction).not.toContain('NEW.payload');
    expect(auditFunction).not.toContain('NEW.payload_hash');
  });
});
