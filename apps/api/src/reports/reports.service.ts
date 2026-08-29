import type {
  IncidentReportGroupBy,
  IncidentReportResponse,
  IncidentReportRow,
} from '@careos/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

export interface ReportsRequestContext {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly correlationId: string;
}

interface AggregateRow {
  readonly key: string;
  readonly label: string;
  readonly total: bigint;
  readonly approved: bigint;
  readonly exported: bigint;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async incidentsAggregate(
    ctx: ReportsRequestContext,
    groupBy: IncidentReportGroupBy,
    filters: { from?: string; to?: string } = {},
  ): Promise<IncidentReportResponse> {
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;

    const rows = await this.prisma.withTenantContext(
      {
        actor: { correlationId: ctx.correlationId, kind: 'user', userId: ctx.actorUserId },
        homeId: ctx.homeId,
        tenantId: ctx.tenantId,
      },
      (transaction) => {
        if (groupBy === 'type') {
          return transaction.$queryRaw<AggregateRow[]>`
          SELECT incident_type AS "key",
                 incident_type AS "label",
                 COUNT(*)::bigint AS "total",
                 COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::bigint AS "approved",
                 COUNT(*) FILTER (WHERE exported_at IS NOT NULL)::bigint AS "exported"
            FROM core.v_incidents_reportable
           WHERE (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
             AND (${to}::timestamptz   IS NULL OR created_at <  ${to}::timestamptz)
        GROUP BY incident_type
        ORDER BY incident_type ASC
        `;
        }

        if (groupBy === 'home') {
          return transaction.$queryRaw<AggregateRow[]>`
          SELECT v.home_id::text AS "key",
                 COALESCE(h.name, v.home_id::text) AS "label",
                 COUNT(*)::bigint AS "total",
                 COUNT(*) FILTER (WHERE v.approved_at IS NOT NULL)::bigint AS "approved",
                 COUNT(*) FILTER (WHERE v.exported_at IS NOT NULL)::bigint AS "exported"
            FROM core.v_incidents_reportable v
       LEFT JOIN core.homes h ON h.id = v.home_id
           WHERE (${from}::timestamptz IS NULL OR v.created_at >= ${from}::timestamptz)
             AND (${to}::timestamptz   IS NULL OR v.created_at <  ${to}::timestamptz)
        GROUP BY v.home_id, h.name
        ORDER BY "label" ASC
        `;
        }

        return transaction.$queryRaw<AggregateRow[]>`
        SELECT to_char(month_bucket, 'YYYY-MM') AS "key",
               to_char(month_bucket, 'YYYY-MM') AS "label",
               COUNT(*)::bigint AS "total",
               COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::bigint AS "approved",
               COUNT(*) FILTER (WHERE exported_at IS NOT NULL)::bigint AS "exported"
          FROM core.v_incidents_reportable
         WHERE (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
           AND (${to}::timestamptz   IS NULL OR created_at <  ${to}::timestamptz)
      GROUP BY month_bucket
      ORDER BY month_bucket ASC
      `;
      },
    );

    const mapped: IncidentReportRow[] = rows.map((row) => ({
      approved: Number(row.approved),
      exported: Number(row.exported),
      key: row.key,
      label: row.label,
      total: Number(row.total),
    }));

    return {
      generatedAt: new Date().toISOString(),
      groupBy,
      rows: mapped,
    };
  }

  /**
   * Renders the aggregate report as a CSV string. Tenancy is enforced because
   * `incidentsAggregate` runs inside a `$transaction` that sets the
   * `app.current_*` GUCs.
   */
  async incidentsAggregateCsv(
    ctx: ReportsRequestContext,
    groupBy: IncidentReportGroupBy,
    filters: { from?: string; to?: string } = {},
  ): Promise<string> {
    const report = await this.incidentsAggregate(ctx, groupBy, filters);
    return renderReportCsv(report);
  }
}

/**
 * Pure helper exported for tests. Escapes the four CSV-special characters
 * (`"`, `,`, CR, LF) by wrapping the field in double quotes whenever any
 * appear and doubling embedded quotes.
 */
export function renderReportCsv(report: IncidentReportResponse): string {
  const header = ['key', 'label', 'total', 'approved', 'exported'];
  const lines = [header.join(',')];
  for (const row of report.rows) {
    lines.push(
      [
        csvField(row.key),
        csvField(row.label),
        String(row.total),
        String(row.approved),
        String(row.exported),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
