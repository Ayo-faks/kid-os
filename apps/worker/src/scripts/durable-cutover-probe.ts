import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createObjectStorage, type ObjectStorage } from '@careos/object-storage';
import { OrchestrationStatus, type TaskHubGrpcClient } from '@microsoft/durabletask-js';
import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';
import { Client as TemporalClient, Connection } from '@temporalio/client';
import { Client as PostgresClient, type QueryResultRow } from 'pg';

import {
  ensureDurableHandoverDueSchedule,
  ensureDurableMissingFieldsSchedule,
  ensureDurableRetentionSchedule,
  ensureDurableSafeguardingDigestSchedule,
  ensureDurableShiftReminderSchedule,
  HANDOVER_DUE_SCHEDULE_INSTANCE_ID,
  MISSING_FIELDS_SCHEDULE_INSTANCE_ID,
  RETENTION_SCHEDULE_INSTANCE_ID,
  SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
  SHIFT_REMINDER_SCHEDULE_INSTANCE_ID,
} from '../durable/worker.js';
import {
  HANDOVER_DUE_REMINDER_SCHEDULE_ID,
  registerHandoverDueReminderSchedule,
} from '../schedules/handover-due-reminder.js';
import {
  MISSING_FIELDS_AUDIT_SCHEDULE_ID,
  registerMissingFieldsAuditSchedule,
} from '../schedules/missing-fields-audit.js';
import {
  registerRetentionSweepSchedule,
  RETENTION_SWEEP_SCHEDULE_ID,
} from '../schedules/retention-sweep.js';
import {
  registerSafeguardingDigestSchedule,
  SAFEGUARDING_DIGEST_SCHEDULE_ID,
} from '../schedules/safeguarding-digest.js';
import {
  registerShiftReminderSchedule,
  SHIFT_REMINDER_SCHEDULE_ID,
} from '../schedules/shift-reminder.js';

type Runtime = 'durable' | 'temporal';
type Phase = 'source' | 'cutover' | 'rollback' | 'finalize' | 'cleanup';

interface ProbeRecord {
  readonly approvalId: string;
  readonly approvalInstanceId: string;
  readonly approvalOwnerId: string;
  readonly incidentId: string;
  readonly incidentInstanceId: string;
  readonly incidentOwnerId: string;
  readonly runtime: Runtime;
}

interface PhaseState {
  readonly activeProbe?: ProbeRecord;
  readonly drillId: string;
  readonly generatedAt: string;
  readonly gitSha: string;
  readonly phase: Phase;
  readonly resolvedProbe?: ProbeRecord;
  readonly rtoSeconds: number;
  readonly runtime: Runtime;
  readonly schedules: ScheduleEvidence;
  readonly status: 'passed';
}

interface ScheduleEvidence {
  readonly durable: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly owner: Runtime;
  readonly temporal: ReadonlyArray<{ readonly id: string; readonly paused: boolean }>;
}

interface WorkflowOwnerRow extends QueryResultRow {
  readonly id: string;
  readonly instance_id: string;
  readonly runtime: Runtime;
  readonly status: string;
  readonly workflow_kind: string;
}

const durableSchedules = [
  { ensure: ensureDurableShiftReminderSchedule, id: SHIFT_REMINDER_SCHEDULE_INSTANCE_ID },
  { ensure: ensureDurableRetentionSchedule, id: RETENTION_SCHEDULE_INSTANCE_ID },
  { ensure: ensureDurableHandoverDueSchedule, id: HANDOVER_DUE_SCHEDULE_INSTANCE_ID },
  { ensure: ensureDurableMissingFieldsSchedule, id: MISSING_FIELDS_SCHEDULE_INSTANCE_ID },
  {
    ensure: ensureDurableSafeguardingDigestSchedule,
    id: SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
  },
] as const;

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  assertRuntime('temporal');
  assertRuntime('durable');
  assertSimpleId('6fc120d6-92d8-4534-84c8-98497212f4fa', 'drill ID');
  process.stdout.write('[durable-cutover-probe] self-test passed\n');
} else {
  await main();
}

async function main(): Promise<void> {
  assertUnmocked();
  const phase = requiredPhase();
  const gitSha = requiredEnvironment('CAREOS_GIT_SHA');
  const drillId = requiredEnvironment('CAREOS_DRILL_ID');
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new Error('CAREOS_GIT_SHA must be a full commit SHA');
  assertSimpleId(drillId, 'CAREOS_DRILL_ID');

  const expectedRuntime = assertRuntime(requiredEnvironment('CAREOS_DRILL_EXPECTED_RUNTIME'));
  const baselineRuntime = assertRuntime(requiredEnvironment('CAREOS_DRILL_BASELINE_RUNTIME'));
  if (phase === 'source' && expectedRuntime !== 'temporal') {
    throw new Error('source phase must run against Temporal admissions');
  }
  if (phase === 'cutover' && expectedRuntime !== 'durable') {
    throw new Error('cutover phase must run against Durable admissions');
  }
  if (phase === 'rollback' && expectedRuntime !== 'temporal') {
    throw new Error('rollback phase must run against Temporal admissions');
  }
  if ((phase === 'finalize' || phase === 'cleanup') && expectedRuntime !== baselineRuntime) {
    throw new Error(`${phase} phase must restore the baseline runtime`);
  }

  const context = new ProbeContext(gitSha, drillId);
  await context.connect();
  try {
    if (phase === 'cleanup') {
      await context.transferSchedules(baselineRuntime);
      process.stdout.write(`[durable-cutover-probe] cleanup restored ${baselineRuntime}\n`);
      return;
    }

    const startedAt = parseSwitchStartedAt();
    if (phase === 'source') {
      const schedules = await context.transferSchedules('temporal');
      const activeProbe = await context.startProbe('temporal');
      await context.writePhase({
        activeProbe,
        drillId,
        generatedAt: new Date().toISOString(),
        gitSha,
        phase,
        rtoSeconds: elapsedSeconds(startedAt),
        runtime: 'temporal',
        schedules,
        status: 'passed',
      });
    } else if (phase === 'cutover') {
      const source = await context.readPhase('source');
      const resolvedProbe = await context.resolveProbe(requiredProbe(source));
      const schedules = await context.transferSchedules('durable');
      const activeProbe = await context.startProbe('durable');
      await context.writePhase({
        activeProbe,
        drillId,
        generatedAt: new Date().toISOString(),
        gitSha,
        phase,
        resolvedProbe,
        rtoSeconds: elapsedSeconds(startedAt),
        runtime: 'durable',
        schedules,
        status: 'passed',
      });
    } else if (phase === 'rollback') {
      const cutover = await context.readPhase('cutover');
      const resolvedProbe = await context.resolveProbe(requiredProbe(cutover));
      const schedules = await context.transferSchedules('temporal');
      const rollbackProbe = await context.startProbe('temporal');
      const activeProbe = await context.resolveProbe(rollbackProbe);
      await context.writePhase({
        activeProbe,
        drillId,
        generatedAt: new Date().toISOString(),
        gitSha,
        phase,
        resolvedProbe,
        rtoSeconds: elapsedSeconds(startedAt),
        runtime: 'temporal',
        schedules,
        status: 'passed',
      });
    } else {
      const source = await context.readPhase('source');
      const cutover = await context.readPhase('cutover');
      const rollback = await context.readPhase('rollback');
      const schedules = await context.transferSchedules(baselineRuntime);
      const restoredProbe = await context.startProbe(baselineRuntime);
      const activeProbe = await context.resolveProbe(restoredProbe);
      await context.finalizeEvidence(
        [requiredProbe(source), requiredProbe(cutover), requiredProbe(rollback), activeProbe],
        { cutover, rollback, source },
        schedules,
        baselineRuntime,
      );
    }
    process.stdout.write(`[durable-cutover-probe] ${phase} passed\n`);
  } finally {
    await context.close();
  }
}

class ProbeContext {
  private readonly database = new PostgresClient({
    connectionString: requiredEnvironment('DATABASE_URL'),
  });
  private readonly storage: ObjectStorage = createObjectStorage();
  private accessToken = '';

  constructor(
    private readonly gitSha: string,
    private readonly drillId: string,
  ) {}

  async connect(): Promise<void> {
    await this.database.connect();
    this.accessToken = await acquireToken();
  }

  async close(): Promise<void> {
    await this.database.end();
  }

  async startProbe(runtime: Runtime): Promise<ProbeRecord> {
    const incidentIdempotencyKey = `${this.drillId}-${runtime}-${Date.now()}`;
    const now = new Date().toISOString();
    const created = await this.apiRequest<{ readonly id: string; readonly workflowId: string }>(
      '/api/incidents',
      {
        body: JSON.stringify({
          formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
          initialFormData: {
            behaviourType: 'other',
            injuries: [],
            location: 'Automated staging validation',
            occurredAt: now,
            outcomeForResident: 'No impact; synthetic validation record.',
            physicalInterventionUsed: false,
            residentId: requiredEnvironment('CAREOS_DRILL_RESIDENT_ID'),
            responseTaken: 'Automated validation completed without intervention.',
            safeguardingConcern: false,
            summary: 'Synthetic cutover and rollback validation record.',
            triggers: ['automated validation'],
            witnesses: [],
          },
          residentId: requiredEnvironment('CAREOS_DRILL_RESIDENT_ID'),
        }),
        headers: { 'idempotency-key': incidentIdempotencyKey },
        method: 'POST',
      },
    );
    assertUuid(created.id, 'incident response id');

    await this.apiRequest(`/api/incidents/${created.id}/submit`, {
      body: '{}',
      headers: { 'idempotency-key': `${incidentIdempotencyKey}-submit` },
      method: 'POST',
    });

    const incidentOwner = await this.waitForOwner('incident', created.id, runtime);
    if (incidentOwner.instance_id !== created.workflowId) {
      throw new Error(`incident ${created.id} response and persisted owner disagree`);
    }
    const approval = await waitFor(async () => {
      const rows = await this.tenantQuery<
        WorkflowOwnerRow & { readonly approval_id: string; readonly approval_status: string }
      >(
        `SELECT
           a.id::text AS approval_id,
           a.status::text AS approval_status,
           w.id::text,
           w.instance_id,
           w.runtime::text,
           w.status,
           w.workflow_kind
         FROM core.approvals a
         JOIN core.workflow_instances w
           ON w.workflow_kind = 'approval'
          AND w.subject_type = 'approval'
          AND w.subject_id = a.id
        WHERE a.subject_type = 'incident'
          AND a.subject_id = $1::uuid
          AND a.status = 'pending'::"core"."ApprovalStatus"
        LIMIT 1`,
        [created.id],
      );
      const row = rows[0];
      return row?.runtime === runtime ? row : undefined;
    }, `pending ${runtime} approval for incident ${created.id}`);

    return {
      approvalId: approval.approval_id,
      approvalInstanceId: approval.instance_id,
      approvalOwnerId: approval.id,
      incidentId: created.id,
      incidentInstanceId: incidentOwner.instance_id,
      incidentOwnerId: incidentOwner.id,
      runtime,
    };
  }

  async resolveProbe(probe: ProbeRecord): Promise<ProbeRecord> {
    await this.apiRequest(`/api/approvals/${probe.approvalId}/reject`, {
      body: JSON.stringify({ reason: 'Automated cutover rollback veto.' }),
      headers: { 'idempotency-key': `${this.drillId}-${probe.approvalId}-reject` },
      method: 'POST',
    });

    await waitFor(async () => {
      const rows = await this.tenantQuery<
        QueryResultRow & {
          readonly approval_owner_status: string;
          readonly approval_status: string;
          readonly incident_owner_status: string;
          readonly incident_status: string;
        }
      >(
        `SELECT
           a.status::text AS approval_status,
           i.status::text AS incident_status,
           approval_owner.status AS approval_owner_status,
           incident_owner.status AS incident_owner_status
         FROM core.approvals a
         JOIN core.incidents i ON i.id = a.subject_id
         JOIN core.workflow_instances approval_owner ON approval_owner.id = $2::uuid
         JOIN core.workflow_instances incident_owner ON incident_owner.id = $3::uuid
        WHERE a.id = $1::uuid`,
        [probe.approvalId, probe.approvalOwnerId, probe.incidentOwnerId],
      );
      const row = rows[0];
      return row?.approval_status === 'rejected' &&
        row.incident_status === 'rejected' &&
        row.approval_owner_status === 'completed' &&
        row.incident_owner_status === 'completed'
        ? true
        : undefined;
    }, `terminal ownership for approval ${probe.approvalId}`);
    return probe;
  }

  async transferSchedules(owner: Runtime): Promise<ScheduleEvidence> {
    return owner === 'temporal'
      ? this.transferSchedulesToTemporal()
      : this.transferSchedulesToDurable();
  }

  async readPhase(phase: Phase): Promise<PhaseState> {
    const stream = await this.storage.getObject('careos-evidence', this.phaseKey(phase));
    const parsed = JSON.parse((await streamToBuffer(stream)).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${phase} state is invalid`);
    const state = parsed as PhaseState;
    if (
      state.status !== 'passed' ||
      state.phase !== phase ||
      state.gitSha !== this.gitSha ||
      state.drillId !== this.drillId
    ) {
      throw new Error(`${phase} state does not match this drill and commit`);
    }
    return state;
  }

  async writePhase(state: PhaseState): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
    await this.storage.putObject(
      'careos-evidence',
      this.phaseKey(state.phase),
      body,
      'application/json',
    );
  }

  async finalizeEvidence(
    probes: readonly ProbeRecord[],
    phases: Readonly<Record<'source' | 'cutover' | 'rollback', PhaseState>>,
    schedules: ScheduleEvidence,
    baselineRuntime: Runtime,
  ): Promise<void> {
    const integrity = await this.assertIntegrity(probes);
    const evidence = {
      assertions: {
        appendOnlyAuditComplete: integrity.auditRegistrations === probes.length * 2,
        authBypassDisabled: true,
        duplicateEffects: integrity.outboxEffects,
        duplicateOwners: integrity.duplicateOwners,
        failedOrPendingCommands: integrity.incompleteCommands,
        persistedOwnership: integrity.ownerCount,
        rpoSeconds: 0,
        routedExistingInstancesByOwner: true,
        scheduleOwner: schedules.owner,
      },
      baselineRuntime,
      drillId: this.drillId,
      generatedAt: new Date().toISOString(),
      gitSha: this.gitSha,
      phases: {
        cutover: { rtoSeconds: phases.cutover.rtoSeconds, runtime: phases.cutover.runtime },
        rollback: { rtoSeconds: phases.rollback.rtoSeconds, runtime: phases.rollback.runtime },
        source: { rtoSeconds: phases.source.rtoSeconds, runtime: phases.source.runtime },
      },
      probeCount: probes.length,
      revisions: {
        durable: requiredEnvironment('CAREOS_DRILL_DURABLE_REVISION'),
        restored: requiredEnvironment('CAREOS_DRILL_ORIGINAL_REVISION'),
        temporal: requiredEnvironment('CAREOS_DRILL_TEMPORAL_REVISION'),
      },
      schedules,
      status: 'passed',
    };
    if (
      integrity.duplicateOwners !== 0 ||
      integrity.incompleteCommands !== 0 ||
      integrity.outboxEffects !== 0 ||
      integrity.ownerCount !== probes.length * 2 ||
      integrity.auditRegistrations !== probes.length * 2
    ) {
      throw new Error('cutover integrity assertions did not pass');
    }
    const evidenceDirectory = resolve('docs', 'artifacts', 'durable', this.gitSha);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      resolve(evidenceDirectory, 'cutover-rollback.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: 'wx' },
    );
  }

  private async transferSchedulesToTemporal(): Promise<ScheduleEvidence> {
    const durableClient = createAzureManagedClient(
      requiredEnvironment('DURABLE_TASK_SCHEDULER_CONNECTION_STRING'),
    );
    const temporal = await this.temporalClient();
    try {
      for (const schedule of durableSchedules) {
        await schedule.ensure(durableClient);
        const state = await durableClient.getOrchestrationState(schedule.id, false);
        if (state === undefined || !isDurableNonTerminal(state.runtimeStatus)) {
          throw new Error(`Durable schedule ${schedule.id} is missing or terminal`);
        }
        if (state.runtimeStatus !== OrchestrationStatus.SUSPENDED) {
          await durableClient.suspendOrchestration(schedule.id);
        }
        await waitForDurableStatus(durableClient, schedule.id, OrchestrationStatus.SUSPENDED);
      }
      await registerTemporalSchedules(temporal.client);
      for (const scheduleId of temporalScheduleIds()) {
        const handle = temporal.client.schedule.getHandle(scheduleId);
        await handle.unpause(`CareOS drill ${this.drillId}: Temporal owns scheduled starts`);
        const description = await handle.describe();
        if (description.state.paused)
          throw new Error(`Temporal schedule ${scheduleId} stayed paused`);
      }
      return this.scheduleEvidence('temporal', durableClient, temporal.client);
    } finally {
      await Promise.all([durableClient.stop(), temporal.connection.close()]);
    }
  }

  private async transferSchedulesToDurable(): Promise<ScheduleEvidence> {
    const durableClient = createAzureManagedClient(
      requiredEnvironment('DURABLE_TASK_SCHEDULER_CONNECTION_STRING'),
    );
    const temporal = await this.temporalClient();
    try {
      await registerTemporalSchedules(temporal.client);
      for (const scheduleId of temporalScheduleIds()) {
        const handle = temporal.client.schedule.getHandle(scheduleId);
        await handle.pause(`CareOS drill ${this.drillId}: Durable owns scheduled starts`);
        const description = await handle.describe();
        if (!description.state.paused)
          throw new Error(`Temporal schedule ${scheduleId} stayed active`);
      }
      for (const schedule of durableSchedules) {
        await schedule.ensure(durableClient);
        const state = await durableClient.getOrchestrationState(schedule.id, false);
        if (state?.runtimeStatus === OrchestrationStatus.SUSPENDED) {
          await durableClient.resumeOrchestration(schedule.id);
        }
        await waitForDurableActive(durableClient, schedule.id);
      }
      return this.scheduleEvidence('durable', durableClient, temporal.client);
    } finally {
      await Promise.all([durableClient.stop(), temporal.connection.close()]);
    }
  }

  private async scheduleEvidence(
    owner: Runtime,
    durableClient: TaskHubGrpcClient,
    temporalClient: TemporalClient,
  ): Promise<ScheduleEvidence> {
    const durable = await Promise.all(
      durableSchedules.map(async ({ id }) => {
        const state = await durableClient.getOrchestrationState(id, false);
        if (state === undefined) throw new Error(`Durable schedule ${id} disappeared`);
        return {
          id,
          status: OrchestrationStatus[state.runtimeStatus] ?? String(state.runtimeStatus),
        };
      }),
    );
    const temporal = await Promise.all(
      temporalScheduleIds().map(async (id) => ({
        id,
        paused: (await temporalClient.schedule.getHandle(id).describe()).state.paused,
      })),
    );
    if (
      owner === 'durable' &&
      (durable.some(({ status }) => status === 'SUSPENDED') ||
        temporal.some(({ paused }) => !paused))
    ) {
      throw new Error('schedule ownership is not exclusively Durable');
    }
    if (
      owner === 'temporal' &&
      (durable.some(({ status }) => status !== 'SUSPENDED') ||
        temporal.some(({ paused }) => paused))
    ) {
      throw new Error('schedule ownership is not exclusively Temporal');
    }
    return { durable, owner, temporal };
  }

  private async temporalClient(): Promise<{
    readonly client: TemporalClient;
    readonly connection: Connection;
  }> {
    const connection = await Connection.connect({ address: requiredEnvironment('TEMPORAL_HOST') });
    return {
      client: new TemporalClient({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      }),
      connection,
    };
  }

  private async waitForOwner(
    workflowKind: string,
    subjectId: string,
    runtime: Runtime,
  ): Promise<WorkflowOwnerRow> {
    return waitFor(async () => {
      const rows = await this.tenantQuery<WorkflowOwnerRow>(
        `SELECT id::text, instance_id, runtime::text, status, workflow_kind
           FROM core.workflow_instances
          WHERE workflow_kind = $1
            AND subject_id = $2::uuid
          LIMIT 1`,
        [workflowKind, subjectId],
      );
      return rows[0]?.runtime === runtime ? rows[0] : undefined;
    }, `${runtime} owner for ${workflowKind}:${subjectId}`);
  }

  private async assertIntegrity(probes: readonly ProbeRecord[]): Promise<{
    readonly auditRegistrations: number;
    readonly duplicateOwners: number;
    readonly incompleteCommands: number;
    readonly outboxEffects: number;
    readonly ownerCount: number;
  }> {
    const subjectIds = probes.map(({ incidentId }) => incidentId);
    const ownerIds = probes.flatMap(({ approvalOwnerId, incidentOwnerId }) => [
      approvalOwnerId,
      incidentOwnerId,
    ]);
    const counts = await this.tenantQuery<
      QueryResultRow & {
        readonly audit_registrations: string;
        readonly duplicate_owners: string;
        readonly incomplete_commands: string;
        readonly outbox_effects: string;
        readonly owner_count: string;
      }
    >(
      `SELECT
         (SELECT count(*) FROM core.workflow_instances
           WHERE id = ANY($2::uuid[])
             AND status = 'completed')::text AS owner_count,
         (SELECT count(*) FROM (
           SELECT workflow_kind, subject_type, subject_id
             FROM core.workflow_instances
            WHERE subject_id = ANY($1::uuid[])
            GROUP BY workflow_kind, subject_type, subject_id
           HAVING count(*) > 1
         ) duplicate)::text AS duplicate_owners,
         (SELECT count(*) FROM core.workflow_commands
           WHERE workflow_instance_id = ANY($2::uuid[])
             AND status <> 'applied'::"core"."WorkflowCommandStatus")::text
           AS incomplete_commands,
         (SELECT count(*) FROM audit.events
           WHERE subject_id = ANY($2::uuid[])
             AND action = 'workflow.instance_registered')::text AS audit_registrations,
         (SELECT count(*) FROM core.outbox
           WHERE payload->>'incidentId' = ANY($1::text[]))::text AS outbox_effects`,
      [subjectIds, ownerIds],
    );
    const row = counts[0];
    if (row === undefined) throw new Error('integrity query returned no row');
    return {
      auditRegistrations: Number(row.audit_registrations),
      duplicateOwners: Number(row.duplicate_owners),
      incompleteCommands: Number(row.incomplete_commands),
      outboxEffects: Number(row.outbox_effects),
      ownerCount: Number(row.owner_count),
    };
  }

  private async apiRequest<T = unknown>(
    path: string,
    init: {
      readonly body?: string;
      readonly headers?: Record<string, string>;
      readonly method: string;
    },
  ): Promise<T> {
    const response = await fetch(new URL(path, requiredEnvironment('CAREOS_BASE_URL')), {
      body: init.body,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        'x-careos-correlation-id': `cutover-drill-${this.drillId}`,
        'x-careos-home-id': requiredEnvironment('CAREOS_DRILL_HOME_ID'),
        ...init.headers,
      },
      method: init.method,
    });
    const body = await response.text();
    if (!response.ok)
      throw new Error(`${init.method} ${path} returned ${response.status}: ${body.slice(0, 300)}`);
    return (body === '' ? undefined : JSON.parse(body)) as T;
  }

  private async tenantQuery<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    await this.database.query('BEGIN');
    try {
      await this.database.query(
        `SELECT
           set_config('app.current_tenant_id', $1, true),
           set_config('app.current_home_id', $2, true),
           set_config('app.current_actor_kind', 'system', true),
           set_config('app.current_actor_user_id', '', true),
           set_config('app.current_correlation_id', $3, true),
           set_config('app.current_agent_run_id', '', true),
           set_config('app.current_prompt_hash', '', true)`,
        [
          requiredEnvironment('CAREOS_DRILL_TENANT_ID'),
          requiredEnvironment('CAREOS_DRILL_HOME_ID'),
          `cutover-drill-${this.drillId}`,
        ],
      );
      const result = await this.database.query<T>(text, [...values]);
      await this.database.query('COMMIT');
      return result.rows;
    } catch (error) {
      await this.database.query('ROLLBACK');
      throw error;
    }
  }

  private phaseKey(phase: Phase): string {
    return `${this.gitSha}/drills/${this.drillId}/${phase}.json`;
  }
}

async function registerTemporalSchedules(client: TemporalClient): Promise<void> {
  const notificationsTaskQueue =
    process.env.TEMPORAL_NOTIFICATIONS_TASK_QUEUE ?? 'careos.notifications';
  await registerShiftReminderSchedule(client, { taskQueue: notificationsTaskQueue });
  await registerHandoverDueReminderSchedule(client, { taskQueue: notificationsTaskQueue });
  await registerMissingFieldsAuditSchedule(client, { taskQueue: notificationsTaskQueue });
  await registerSafeguardingDigestSchedule(client, { taskQueue: notificationsTaskQueue });
  await registerRetentionSweepSchedule(client, {
    taskQueue: process.env.TEMPORAL_RETENTION_TASK_QUEUE ?? 'careos.retention',
  });
}

function temporalScheduleIds(): readonly string[] {
  return [
    SHIFT_REMINDER_SCHEDULE_ID,
    HANDOVER_DUE_REMINDER_SCHEDULE_ID,
    MISSING_FIELDS_AUDIT_SCHEDULE_ID,
    SAFEGUARDING_DIGEST_SCHEDULE_ID,
    RETENTION_SWEEP_SCHEDULE_ID,
  ];
}

async function acquireToken(): Promise<string> {
  const response = await fetch(requiredEnvironment('KEYCLOAK_TOKEN_URL'), {
    body: new URLSearchParams({
      client_id: process.env.CAREOS_DRILL_CLIENT_ID ?? 'careos-cutover-drill',
      client_secret: requiredEnvironment('CAREOS_DRILL_CLIENT_SECRET'),
      grant_type: 'client_credentials',
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Keycloak token request returned ${response.status}`);
  const payload = (await response.json()) as { readonly access_token?: unknown };
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw new Error('Keycloak token response omitted access_token');
  }
  const claims = decodeJwtPayload(payload.access_token);
  if (claims.tenant_id !== requiredEnvironment('CAREOS_DRILL_TENANT_ID')) {
    throw new Error('drill token tenant claim does not match the staging tenant');
  }
  if (!stringArray(claims.home_ids).includes(requiredEnvironment('CAREOS_DRILL_HOME_ID'))) {
    throw new Error('drill token does not contain the staging home');
  }
  if (!stringArray(claims.roles).includes('ops_admin')) {
    throw new Error('drill token must carry the ops_admin veto role');
  }
  return payload.access_token;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (encoded === undefined) throw new Error('Keycloak returned a malformed access token');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function waitForDurableStatus(
  client: TaskHubGrpcClient,
  instanceId: string,
  expected: OrchestrationStatus,
): Promise<void> {
  await waitFor(async () => {
    const state = await client.getOrchestrationState(instanceId, false);
    return state?.runtimeStatus === expected ? true : undefined;
  }, `${instanceId} status ${OrchestrationStatus[expected]}`);
}

async function waitForDurableActive(client: TaskHubGrpcClient, instanceId: string): Promise<void> {
  await waitFor(async () => {
    const state = await client.getOrchestrationState(instanceId, false);
    return state !== undefined &&
      isDurableNonTerminal(state.runtimeStatus) &&
      state.runtimeStatus !== OrchestrationStatus.SUSPENDED
      ? true
      : undefined;
  }, `${instanceId} active`);
}

function isDurableNonTerminal(status: OrchestrationStatus): boolean {
  return [
    OrchestrationStatus.PENDING,
    OrchestrationStatus.RUNNING,
    OrchestrationStatus.SUSPENDED,
    OrchestrationStatus.CONTINUED_AS_NEW,
  ].includes(status);
}

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 180_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(
    `${description} did not become ready within 180 seconds${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requiredProbe(state: PhaseState): ProbeRecord {
  if (state.activeProbe === undefined) throw new Error(`${state.phase} state omitted activeProbe`);
  return state.activeProbe;
}

function assertUnmocked(): void {
  for (const name of [
    'CAREOS_E2E_AUTH_BYPASS',
    'CAREOS_TEST_AUTH_BYPASS',
    'CAREOS_E2E_STATIC_DATA',
  ]) {
    if (process.env[name] === 'true') throw new Error(`${name}=true is forbidden during the drill`);
  }
  if (process.env.OBJECT_STORAGE_PROVIDER !== 'azure') {
    throw new Error('cutover evidence requires OBJECT_STORAGE_PROVIDER=azure');
  }
}

function requiredPhase(): Phase {
  const phase = requiredEnvironment('CAREOS_DRILL_PHASE');
  if (!['source', 'cutover', 'rollback', 'finalize', 'cleanup'].includes(phase)) {
    throw new Error(`unknown CAREOS_DRILL_PHASE: ${phase}`);
  }
  return phase as Phase;
}

function assertRuntime(value: string): Runtime {
  if (value !== 'temporal' && value !== 'durable') throw new Error(`invalid runtime: ${value}`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function assertSimpleId(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error(`${name} is invalid`);
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} is not a UUID`);
  }
}

function parseSwitchStartedAt(): number {
  const value = Date.parse(requiredEnvironment('CAREOS_DRILL_SWITCH_STARTED_AT'));
  if (!Number.isFinite(value) || value > Date.now()) throw new Error('invalid switch start time');
  return value;
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}
