import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { ApprovalsModule } from './approvals/approvals.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AutomationsModule } from './automations/automations.module.js';
import { MattermostModule } from './comms/mattermost/mattermost.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { EmailDraftsModule } from './email-drafts/email-drafts.module.js';
import { ExportBundlesModule } from './export-bundles/export-bundles.module.js';
import { HandoversModule } from './handovers/handovers.module.js';
import { HealthModule } from './health/health.module.js';
import { HomeSettingsModule } from './home-settings/home-settings.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { LlmRouterModule } from './llm-router/llm-router.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ResidentsModule } from './residents/residents.module.js';
import { RetentionModule } from './retention/retention.module.js';
import { RotaModule } from './rota/rota.module.js';
import { TemporalModule } from './temporal/temporal.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                },
              },
      },
    }),
    HttpModule,
    PrismaModule,
    AuthModule,
    TenantModule,
    UsersModule,
    IdempotencyModule,
    AuditModule,
    HealthModule,
    McpModule,
    ObservabilityModule,
    LlmRouterModule,
    TemporalModule,
    IncidentsModule,
    HandoversModule,
    EmailDraftsModule,
    ApprovalsModule,
    AssistantModule,
    ResidentsModule,
    RotaModule,
    MattermostModule,
    AutomationsModule,
    DocumentsModule,
    ExportBundlesModule,
    ReportsModule,
    HomeSettingsModule,
    RetentionModule,
  ],
})
export class AppModule {}
