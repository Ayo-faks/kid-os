import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { DurableApprovalEventClient } from '../workflow-runtime/durable-approval-event.client.js';
import { DurableDocumentClient } from '../workflow-runtime/durable-document.client.js';
import { DurableEmailDraftClient } from '../workflow-runtime/durable-email-draft.client.js';
import { DurableExportBundleClient } from '../workflow-runtime/durable-export-bundle.client.js';
import { DurableHandoverClient } from '../workflow-runtime/durable-handover.client.js';
import { DurableIncidentClient } from '../workflow-runtime/durable-incident.client.js';
import { DurablePingClient } from '../workflow-runtime/durable-ping.client.js';
import { DurableRetentionClient } from '../workflow-runtime/durable-retention.client.js';
import { DurableRotaAnalyzeClient } from '../workflow-runtime/durable-rota-analyze.client.js';
import { DurableRotaPublishClient } from '../workflow-runtime/durable-rota-publish.client.js';
import { TemporalWorkflowRuntimeAdapter } from '../workflow-runtime/temporal-workflow-runtime.adapter.js';
import { WORKFLOW_RUNTIME } from '../workflow-runtime/workflow-runtime.port.js';
import { WorkflowRuntimeRouter } from '../workflow-runtime/workflow-runtime.router.js';

import { TemporalController } from './temporal.controller.js';
import { TemporalService } from './temporal.service.js';

@Module({
  controllers: [TemporalController],
  exports: [TemporalService, WORKFLOW_RUNTIME],
  imports: [PrismaModule],
  providers: [
    TemporalService,
    TemporalWorkflowRuntimeAdapter,
    DurableApprovalEventClient,
    DurableDocumentClient,
    DurableEmailDraftClient,
    DurableExportBundleClient,
    DurableHandoverClient,
    DurableRetentionClient,
    DurableRotaAnalyzeClient,
    DurableRotaPublishClient,
    DurableIncidentClient,
    DurablePingClient,
    WorkflowRuntimeRouter,
    {
      provide: WORKFLOW_RUNTIME,
      useExisting: WorkflowRuntimeRouter,
    },
  ],
})
export class TemporalModule {}
