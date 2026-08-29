import { Client as TemporalClient, Connection } from '@temporalio/client';
import { Client as PostgresClient } from 'pg';

import { HANDOVER_DUE_REMINDER_SCHEDULE_ID } from '../schedules/handover-due-reminder.js';
import { MISSING_FIELDS_AUDIT_SCHEDULE_ID } from '../schedules/missing-fields-audit.js';
import { RETENTION_SWEEP_SCHEDULE_ID } from '../schedules/retention-sweep.js';
import { SAFEGUARDING_DIGEST_SCHEDULE_ID } from '../schedules/safeguarding-digest.js';
import { SHIFT_REMINDER_SCHEDULE_ID } from '../schedules/shift-reminder.js';

const temporalScheduleIds = [
  SHIFT_REMINDER_SCHEDULE_ID,
  HANDOVER_DUE_REMINDER_SCHEDULE_ID,
  MISSING_FIELDS_AUDIT_SCHEDULE_ID,
  SAFEGUARDING_DIGEST_SCHEDULE_ID,
  RETENTION_SWEEP_SCHEDULE_ID,
];

if (process.argv.includes('--self-test')) {
  if (!isNonTerminalOwnerStatus('pending') || !isNonTerminalOwnerStatus('running')) {
    throw new Error('non-terminal status self-test failed');
  }
  if (isNonTerminalOwnerStatus('completed')) throw new Error('terminal status self-test failed');
  process.stdout.write('[temporal-decommission-inventory] self-test passed\n');
} else {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[temporal-decommission-inventory] ${redactConnectionString(message)}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const database = new PostgresClient({
    connectionString: requiredEnvironment('MIGRATION_DATABASE_URL'),
  });
  const temporalConnection = await Connection.connect({
    address: requiredEnvironment('TEMPORAL_HOST'),
  });
  const temporal = new TemporalClient({
    connection: temporalConnection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });

  await database.connect();
  try {
    const databaseCounts = await queryDatabaseCounts(database);
    let visibilityNonTerminal = 0;
    for await (const _workflow of temporal.workflow.list({
      query: 'ExecutionStatus = "Running"',
    })) {
      visibilityNonTerminal += 1;
    }

    let pausedSchedules = 0;
    for (const scheduleId of temporalScheduleIds) {
      const description = await temporal.schedule.getHandle(scheduleId).describe();
      if (description.state.paused) pausedSchedules += 1;
    }

    process.stdout.write(
      `${JSON.stringify({
        database: databaseCounts,
        generatedAt: new Date().toISOString(),
        mocked: false,
        status: 'passed',
        temporal: {
          nonTerminalExecutions: visibilityNonTerminal,
          pausedSchedules,
          scheduleCount: temporalScheduleIds.length,
        },
      })}\n`,
    );
  } finally {
    await Promise.all([database.end(), temporalConnection.close()]);
  }
}

async function queryDatabaseCounts(database: PostgresClient): Promise<{
  readonly ambiguousOwners: number;
  readonly systemTemporalNonTerminal: number;
  readonly tenantTemporalNonTerminal: number;
}> {
  await database.query('BEGIN READ ONLY');
  try {
    await database.query('SET LOCAL row_security = off');
    const result = await database.query<{
      readonly ambiguous_owners: string;
      readonly system_temporal_non_terminal: string;
      readonly tenant_temporal_non_terminal: string;
    }>(
      `SELECT
         (SELECT count(*)
            FROM core.workflow_instances
           WHERE runtime = 'temporal'::"core"."WorkflowRuntimeKind"
             AND status IN ('pending', 'running'))::text AS tenant_temporal_non_terminal,
         (SELECT count(*)
            FROM core.system_workflow_instances
           WHERE runtime = 'temporal'::"core"."WorkflowRuntimeKind"
             AND status IN ('pending', 'running'))::text AS system_temporal_non_terminal,
         (SELECT count(*) FROM (
           SELECT tenant_id, home_id, workflow_kind, subject_type, subject_id
             FROM core.workflow_instances
            GROUP BY tenant_id, home_id, workflow_kind, subject_type, subject_id
           HAVING count(*) > 1
         ) duplicates)::text AS ambiguous_owners`,
    );
    await database.query('COMMIT');
    const row = result.rows[0];
    if (row === undefined) throw new Error('database inventory returned no row');
    return {
      ambiguousOwners: Number(row.ambiguous_owners),
      systemTemporalNonTerminal: Number(row.system_temporal_non_terminal),
      tenantTemporalNonTerminal: Number(row.tenant_temporal_non_terminal),
    };
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
}

function isNonTerminalOwnerStatus(status: string): boolean {
  return status === 'pending' || status === 'running';
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function redactConnectionString(value: string): string {
  return value.replace(/(?:postgres(?:ql)?):\/\/[^\s]+/gi, '[redacted-postgres-url]');
}
