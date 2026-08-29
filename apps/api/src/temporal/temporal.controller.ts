import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/public.decorator.js';
import {
  WORKFLOW_RUNTIME,
  type PingWorkflowRuntime,
  type StartedPingWorkflow,
} from '../workflow-runtime/workflow-runtime.port.js';

@ApiTags('temporal')
@Public()
@Controller('temporal')
export class TemporalController {
  constructor(@Inject(WORKFLOW_RUNTIME) private readonly workflowRuntime: PingWorkflowRuntime) {}

  @Post('ping')
  @HttpCode(202)
  @ApiBody({
    required: false,
    schema: {
      additionalProperties: false,
      properties: {
        message: { type: 'string' },
      },
      type: 'object',
    },
  })
  @ApiAcceptedResponse({ description: 'Starts the Phase 0 PingWorkflow smoke run.' })
  async startPing(@Body() body: unknown): Promise<StartedPingWorkflow> {
    return this.workflowRuntime.startPingWorkflow(this.readMessage(body));
  }

  private readMessage(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null || !('message' in body)) {
      return undefined;
    }

    return typeof body.message === 'string' && body.message.length > 0 ? body.message : undefined;
  }
}
