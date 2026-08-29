import { randomUUID } from 'node:crypto';

import { handoverWorkflowId, type HandoverActor } from '@careos/contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
  WORKFLOW_RUNTIME,
  type HandoverWorkflowRuntime,
} from '../workflow-runtime/workflow-runtime.port.js';

import type { CreateHandoverDto, CreateHandoverResponse } from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly actor: HandoverActor;
}

@Injectable()
export class HandoversService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: HandoverWorkflowRuntime,
  ) {}

  async create(dto: CreateHandoverDto, context: RequestContext): Promise<CreateHandoverResponse> {
    const handoverId = randomUUID();
    const started = await this.workflowRuntime.startHandoverWorkflow({
      authorUserId: context.authorUserId,
      correlationId: context.correlationId,
      freeText: dto.free_text,
      handoverId,
      homeId: context.homeId,
      shiftId: dto.shift_id,
      tenantId: context.tenantId,
      transcriptObjectKey: dto.transcript_object_key,
    });

    return {
      id: started.handoverId,
      status: 'processing',
      workflowId: started.workflowId ?? handoverWorkflowId(handoverId),
    };
  }
}
