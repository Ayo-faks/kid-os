import { randomUUID } from 'node:crypto';

import { emailDraftWorkflowId, type EmailDraftActor } from '@careos/contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
  WORKFLOW_RUNTIME,
  type EmailDraftWorkflowRuntime,
} from '../workflow-runtime/workflow-runtime.port.js';

import type { CreateEmailDraftDto, CreateEmailDraftResponse } from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly actor: EmailDraftActor;
}

@Injectable()
export class EmailDraftsService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: EmailDraftWorkflowRuntime,
  ) {}

  async create(
    dto: CreateEmailDraftDto,
    context: RequestContext,
  ): Promise<CreateEmailDraftResponse> {
    const emailDraftId = randomUUID();
    const started = await this.workflowRuntime.startEmailDraftWorkflow({
      authorUserId: context.authorUserId,
      correlationId: context.correlationId,
      emailDraftId,
      homeId: context.homeId,
      instructions: dto.instructions,
      recipient: dto.recipient,
      source: dto.source,
      tenantId: context.tenantId,
    });

    return {
      id: started.emailDraftId,
      status: 'processing',
      workflowId: started.workflowId ?? emailDraftWorkflowId(emailDraftId),
    };
  }
}
