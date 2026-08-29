import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../prisma/migrations/0024_system_workflow_runtime/migration.sql',
  ),
  'utf8',
);

describe('0024 system workflow runtime migration', () => {
  it('persists tenantless ownership and private command payloads separately', () => {
    expect(migration).toContain('CREATE TABLE "core"."system_workflow_instances"');
    expect(migration).toContain('CREATE TABLE "core"."system_workflow_commands"');
    expect(migration).toContain('system_workflow_commands_payload_object_check');
    expect(migration).toContain('system_workflow_commands_result_object_check');
    expect(migration).toContain('system_workflow_commands_dedupe_key');
  });

  it('forces actor-kind system RLS on both tables', () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration).toContain('system_workflow_instances_system_only');
    expect(migration).toContain('system_workflow_commands_system_only');
    expect(migration.match(/current_actor_kind/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces scheduler-compatible instance IDs and append-preserving foreign keys', () => {
    expect(migration).toContain('system_workflow_instances_id_format_check');
    expect(migration).toContain("instance_id\" !~ '^@'");
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).not.toMatch(/ON DELETE CASCADE/i);
  });
});
