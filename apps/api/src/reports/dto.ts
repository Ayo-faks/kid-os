import type {
  IncidentReportGroupBy,
  IncidentReportResponse,
  IncidentReportRow,
} from '@careos/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const groupByValues = ['type', 'home', 'month'] as const satisfies readonly IncidentReportGroupBy[];

export const ReportFiltersSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export class ReportFiltersDto extends createZodDto(ReportFiltersSchema) {}

export const ReportGroupBySchema = z
  .object({
    groupBy: z.enum(groupByValues),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export class ReportGroupByDto extends createZodDto(ReportGroupBySchema) {}

export const ExportPdfBodySchema = z
  .object({
    groupBy: z.enum(groupByValues),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export class ExportPdfBodyDto extends createZodDto(ExportPdfBodySchema) {}

export type { IncidentReportGroupBy, IncidentReportResponse, IncidentReportRow };
