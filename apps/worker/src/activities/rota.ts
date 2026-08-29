import { createHash, randomUUID } from 'node:crypto';

import type {
  AnalyzeRotaInput,
  AnalyzeRotaResult,
  LoadRotaContextInput,
  LoadRotaContextResult,
  NarrateRotaAnalysisInput,
  NarrateRotaAnalysisResult,
  PublishRotaInput,
  PublishRotaResult,
  RotaRuleKind,
  RotaShiftSnapshot,
  RotaStaffSnapshot,
} from '@careos/contracts';

import { withTenantContext } from '../db/pg.js';

import { callHermesTool } from './hermes.js';
import { analyzeRota as runSolver } from './rota-solver.js';

interface HermesNarrateRotaResult {
  readonly narration?: string;
  readonly refused?: boolean;
  readonly [key: string]: unknown;
}

interface ShiftRow {
  readonly id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly required_role: string;
  readonly min_headcount: number;
}

interface AssignmentRow {
  readonly id: string;
  readonly shift_id: string;
  readonly user_id: string;
  readonly state: 'tentative' | 'confirmed' | 'published';
}

interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly kind: RotaRuleKind;
  readonly parameters: unknown;
  readonly active: boolean;
}

interface UserRow {
  readonly id: string;
  readonly display_name: string;
  readonly gender: string | null;
  readonly qualifications: unknown;
  readonly roles: unknown;
}

export async function loadRotaContext(input: LoadRotaContextInput): Promise<LoadRotaContextResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const shifts = await client.query<ShiftRow>(
        `SELECT id, starts_at, ends_at, required_role, min_headcount
           FROM core.shifts
          WHERE starts_at < $2::timestamp
            AND ends_at   > $1::timestamp
          ORDER BY starts_at ASC, id ASC`,
        [input.periodStart, input.periodEnd],
      );
      const shiftIds = shifts.rows.map((row) => row.id);

      const assignments =
        shiftIds.length === 0
          ? { rows: [] as AssignmentRow[] }
          : await client.query<AssignmentRow>(
              `SELECT id, shift_id, user_id, state
                 FROM core.shift_assignments
                WHERE shift_id = ANY($1::uuid[])`,
              [shiftIds],
            );

      const rules = await client.query<RuleRow>(
        `SELECT id, name, kind, parameters, active
           FROM core.rota_rules
          ORDER BY name ASC, id ASC`,
        [],
      );

      const users = await client.query<UserRow>(
        `SELECT id, display_name, gender, qualifications, roles
           FROM core.users
          WHERE disabled = false
            AND ($1::uuid = ANY(home_ids) OR home_ids IS NULL)
          ORDER BY display_name ASC, id ASC`,
        [input.homeId],
      );

      const assignmentsByShift = new Map<string, AssignmentRow[]>();
      for (const row of assignments.rows) {
        const list = assignmentsByShift.get(row.shift_id) ?? [];
        list.push(row);
        assignmentsByShift.set(row.shift_id, list);
      }

      const shiftSnapshots: RotaShiftSnapshot[] = shifts.rows.map((row) => ({
        assignedUserIds: (assignmentsByShift.get(row.id) ?? [])
          .map((entry) => entry.user_id)
          .sort(),
        endsAt: row.ends_at.toISOString(),
        id: row.id,
        minHeadcount: row.min_headcount,
        requiredRole: row.required_role,
        startsAt: row.starts_at.toISOString(),
      }));

      const staffSnapshots: RotaStaffSnapshot[] = users.rows.map((row) => ({
        displayName: row.display_name,
        gender: row.gender,
        qualifications: toStringArray(row.qualifications),
        roles: toStringArray(row.roles),
        userId: row.id,
      }));

      const ruleSnapshots = rules.rows.map((row) => ({
        active: row.active,
        id: row.id,
        kind: row.kind,
        name: row.name,
        parameters: isRecord(row.parameters) ? row.parameters : {},
      }));

      return {
        rules: ruleSnapshots,
        shifts: shiftSnapshots,
        staff: staffSnapshots,
      };
    },
  );
}

// eslint-disable-next-line @typescript-eslint/require-await -- activity contract requires Promise return
export async function analyzeRota(input: AnalyzeRotaInput): Promise<AnalyzeRotaResult> {
  return runSolver(input);
}

export async function narrateRotaAnalysis(
  input: NarrateRotaAnalysisInput,
): Promise<NarrateRotaAnalysisResult> {
  const promptHash = sha256(
    JSON.stringify({
      gaps: input.gaps,
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      proposals: input.proposals,
      shifts: input.shifts.map((shift) => shift.id),
    }),
  );

  if (input.gaps.length === 0 && input.proposals.length === 0) {
    return {
      narration: 'No rota gaps detected for the selected period.',
      promptHash,
      refused: false,
    };
  }

  const json = await callHermesTool<HermesNarrateRotaResult>(
    'narrate_rota',
    {
      correlation_id: input.correlationId,
      gaps: input.gaps,
      period_end: input.periodEnd,
      period_start: input.periodStart,
      proposals: input.proposals,
      shifts: input.shifts,
    },
    {
      correlationId: input.correlationId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
  );

  const refused = json.refused === true;
  const narration = typeof json.narration === 'string' ? json.narration.trim() : '';

  return {
    narration: refused || narration === '' ? '' : narration,
    promptHash,
    refused,
  };
}

export async function publishRota(input: PublishRotaInput): Promise<PublishRotaResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const existing = await client.query<{
        readonly id: string;
        readonly assignment_ids: string[];
        readonly status: 'published' | 'failed';
      }>(
        `SELECT id, assignment_ids, status
           FROM core.rota_publications
          WHERE workflow_id = $1
          LIMIT 1`,
        [input.workflowId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row) {
          return {
            publicationId: row.id,
            publishedAssignmentIds: row.assignment_ids ?? [],
            status: row.status,
          };
        }
      }

      const shiftIds = [...input.shiftIds];
      const assignmentRows =
        shiftIds.length === 0
          ? { rows: [] as { readonly id: string }[] }
          : await client.query<{ readonly id: string }>(
              `UPDATE core.shift_assignments
                  SET state = 'published'::"core"."ShiftAssignmentState",
                      updated_at = now()
                WHERE shift_id = ANY($1::uuid[])
                  AND state <> 'published'::"core"."ShiftAssignmentState"
                RETURNING id`,
              [shiftIds],
            );
      const publishedAssignmentIds = assignmentRows.rows.map((row) => row.id);

      await client.query(
        `INSERT INTO core.rota_publications
           (id, tenant_id, home_id, workflow_id, status,
            period_start, period_end, shift_ids, assignment_ids,
            published_by_user_id, note, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4,
                 'published'::"core"."RotaPublicationStatus",
                 $5::timestamp, $6::timestamp, $7::uuid[], $8::uuid[],
                 $9::uuid, $10, now())
         ON CONFLICT (workflow_id) DO NOTHING`,
        [
          input.publicationId,
          input.tenantId,
          input.homeId,
          input.workflowId,
          input.periodStart,
          input.periodEnd,
          shiftIds,
          publishedAssignmentIds,
          input.publishedByUserId,
          input.note ?? null,
        ],
      );

      return {
        publicationId: input.publicationId,
        publishedAssignmentIds,
        status: 'published',
      };
    },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

// Exposed for tests that need a deterministic publicationId generator.
export function newPublicationId(): string {
  return randomUUID();
}
