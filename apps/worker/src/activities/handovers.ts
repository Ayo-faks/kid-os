import { createHash, randomUUID } from 'node:crypto';

import type {
  PersistHandoverInput,
  PersistHandoverResult,
  SummarizeHandoverInput,
  SummarizeHandoverResult,
  ValidateHandoverInput,
  ValidateHandoverResult,
} from '@careos/contracts';
import { validateFormData } from '@careos/schemas';

import { withTenantContext } from '../db/pg.js';

import { callHermesTool } from './hermes.js';

export async function summarizeHandover(
  input: SummarizeHandoverInput,
): Promise<SummarizeHandoverResult> {
  const promptHash = sha256(
    JSON.stringify({
      freeText: input.freeText,
      shiftId: input.shiftId,
      transcriptObjectKey: input.transcriptObjectKey ?? null,
    }),
  );

  const json = await callHermesTool<{
    readonly confidence?: number;
    readonly form_data?: Record<string, unknown>;
    readonly missing_mandatory?: readonly string[];
    readonly summary?: string;
  }>(
    'summarize_handover',
    {
      correlation_id: input.correlationId,
      free_text: input.freeText,
      shift_id: input.shiftId,
      transcript_object_key: input.transcriptObjectKey ?? null,
    },
    {
      correlationId: input.correlationId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
  );

  const formData = {
    narrative: input.freeText,
    ...(isRecord(json.form_data) ? json.form_data : {}),
    shiftId: input.shiftId,
  } satisfies Record<string, unknown>;

  return {
    confidence: coerceConfidence(json.confidence),
    formData,
    missingMandatory: Array.isArray(json.missing_mandatory) ? json.missing_mandatory : [],
    promptHash,
    summary:
      typeof json.summary === 'string' && json.summary.trim() !== ''
        ? json.summary
        : input.freeText,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- activity contract requires Promise return
export async function validateHandover(
  input: ValidateHandoverInput,
): Promise<ValidateHandoverResult> {
  return validateFormData('handover.shift-end', 'v1', input.formData);
}

export async function persistHandover(input: PersistHandoverInput): Promise<PersistHandoverResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const currentShiftResult = await client.query<{
        readonly ends_at: Date;
      }>(
        `SELECT ends_at
           FROM core.shifts
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND home_id = $3::uuid
          LIMIT 1`,
        [input.shiftId, input.tenantId, input.homeId],
      );
      const currentShift = currentShiftResult.rows[0];
      if (!currentShift) {
        throw new Error(`persistHandover: shift ${input.shiftId} not found.`);
      }

      const nextShiftResult = await client.query<{
        readonly id: string;
        readonly starts_at: Date;
      }>(
        `SELECT id, starts_at
           FROM core.shifts
          WHERE tenant_id = $1::uuid
            AND home_id = $2::uuid
            AND starts_at >= $3
            AND id <> $4::uuid
          ORDER BY starts_at ASC
          LIMIT 1`,
        [input.tenantId, input.homeId, currentShift.ends_at, input.shiftId],
      );
      const nextShift = nextShiftResult.rows[0];

      const assigneeUserIds = nextShift
        ? await nextShiftAssignees(input.tenantId, input.homeId, nextShift.id, client)
        : [];

      const existing = await existingHandoverTaskIds(input.handoverId, client);
      if (existing !== undefined) {
        return {
          assigneeUserIds,
          handoverId: input.handoverId,
          nextShiftId: nextShift?.id,
          taskIds: existing,
        };
      }

      await client.query(
        `INSERT INTO core.handover_records
           (id, tenant_id, home_id, shift_id, workflow_id, status, source_text,
            transcript_object_key, structured_payload, summary, created_by_user_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 'completed'::"core"."HandoverStatus", $6, $7, $8::jsonb, $9, $10::uuid, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          input.handoverId,
          input.tenantId,
          input.homeId,
          input.shiftId,
          input.workflowId,
          input.sourceText,
          input.transcriptObjectKey ?? null,
          JSON.stringify(input.formData),
          input.summary,
          input.authorUserId,
        ],
      );

      const taskIds: string[] = [];
      const followUps = residentsRequiringFollowUp(input.formData);
      const assigneeTargets = assigneeUserIds.length > 0 ? assigneeUserIds : [null];

      for (const followUp of followUps) {
        for (const assigneeUserId of assigneeTargets) {
          const taskId = randomUUID();
          const title = `Handover follow-up: ${truncate(followUp.note, 64)}`;
          await client.query(
            `INSERT INTO core.tasks
               (id, tenant_id, home_id, resident_id, title, detail, status, due_at,
                assigned_user_id, created_by_user_id, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
                     'open'::"core"."TaskStatus", $7, $8::uuid, $9::uuid, now(), now())`,
            [
              taskId,
              input.tenantId,
              input.homeId,
              followUp.residentId,
              title,
              followUp.note,
              nextShift?.starts_at ?? null,
              assigneeUserId,
              input.authorUserId,
            ],
          );
          await client.query(
            `INSERT INTO core.handover_tasks
               (id, tenant_id, home_id, handover_record_id, task_id, created_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, now())`,
            [input.tenantId, input.homeId, input.handoverId, taskId],
          );
          await client.query(
            `INSERT INTO core.timeline_entries
               (id, tenant_id, home_id, resident_id, kind, occurred_at, summary, payload,
                task_id, actor_kind, actor_user_id, created_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'task', now(),
                     $4, $5::jsonb, $6::uuid, $7, $8::uuid, now())`,
            [
              input.tenantId,
              input.homeId,
              followUp.residentId,
              title,
              JSON.stringify({ handoverId: input.handoverId, priority: followUp.priority }),
              taskId,
              input.actor.kind,
              input.actor.userId,
            ],
          );
          taskIds.push(taskId);
        }
      }

      return {
        assigneeUserIds,
        handoverId: input.handoverId,
        nextShiftId: nextShift?.id,
        taskIds,
      };
    },
  );
}

async function existingHandoverTaskIds(
  handoverId: string,
  client: Parameters<Parameters<typeof withTenantContext>[1]>[0],
): Promise<string[] | undefined> {
  const rows = await client.query<{ readonly task_id: string | null }>(
    `SELECT ht.task_id
       FROM core.handover_records hr
       LEFT JOIN core.handover_tasks ht ON ht.handover_record_id = hr.id
      WHERE hr.id = $1::uuid
      ORDER BY ht.created_at ASC, ht.task_id ASC`,
    [handoverId],
  );
  if (rows.rowCount === 0) {
    return undefined;
  }
  return rows.rows.flatMap((row) => (row.task_id === null ? [] : [row.task_id]));
}

async function nextShiftAssignees(
  tenantId: string,
  homeId: string,
  shiftId: string,
  client: Parameters<Parameters<typeof withTenantContext>[1]>[0],
): Promise<string[]> {
  const rows = await client.query<{ readonly user_id: string }>(
    `SELECT user_id
       FROM core.shift_assignments
      WHERE tenant_id = $1::uuid
        AND home_id = $2::uuid
        AND shift_id = $3::uuid
        AND state IN ('confirmed'::"core"."ShiftAssignmentState", 'published'::"core"."ShiftAssignmentState")
      ORDER BY created_at ASC, user_id ASC`,
    [tenantId, homeId, shiftId],
  );
  return rows.rows.map((row) => row.user_id);
}

interface FollowUp {
  readonly residentId: string;
  readonly note: string;
  readonly priority: 'low' | 'medium' | 'high';
}

function residentsRequiringFollowUp(formData: Record<string, unknown>): readonly FollowUp[] {
  const raw = formData.residentsRequiringFollowUp;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const residentId = item.residentId;
    const note = item.note;
    if (typeof residentId !== 'string' || typeof note !== 'string' || note.trim() === '') {
      return [];
    }
    const priority = item.priority === 'low' || item.priority === 'high' ? item.priority : 'medium';
    return [{ note: note.trim(), priority, residentId }];
  });
}

function coerceConfidence(value: unknown): number {
  return typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
