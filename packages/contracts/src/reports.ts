// Phase 4 §1 — Reports module shared types.

export type IncidentReportGroupBy = 'type' | 'home' | 'month';

export interface IncidentReportContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly correlationId: string;
}

export interface IncidentReportRow {
  readonly key: string;
  readonly label: string;
  readonly total: number;
  readonly approved: number;
  readonly exported: number;
}

export interface IncidentReportResponse {
  readonly groupBy: IncidentReportGroupBy;
  readonly rows: readonly IncidentReportRow[];
  readonly generatedAt: string;
}

export interface IncidentReportFilters {
  /** ISO date (inclusive). */
  readonly from?: string;
  /** ISO date (exclusive). */
  readonly to?: string;
}
