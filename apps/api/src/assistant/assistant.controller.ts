import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { AssistantService } from './assistant.service.js';
import { AssistantMessageDto } from './dto.js';
import { QUICK_ACTIONS, type QuickAction } from './quick-actions.js';

/**
 * Interval between SSE comment heartbeats. Local models can take minutes to
 * produce the first token; without body bytes on the wire, intermediaries
 * (undici's 300s bodyTimeout in the web BFF, reverse proxies) abort the
 * stream and the browser sees a bogus 502 while generation is still running.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

@ApiTags('assistant')
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('quick-actions')
  @ApiOkResponse({ description: 'Static list of supported quick-actions.' })
  quickActions(): { readonly items: readonly QuickAction[] } {
    return { items: Object.values(QUICK_ACTIONS) };
  }

  @Post('messages')
  @HttpCode(200)
  async messages(
    @Body() dto: AssistantMessageDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (request.tenant === undefined || request.auth === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders?.();
    raw.write(': stream-open\n\n');

    const aborted = new AbortController();
    const abortStream = () => aborted.abort();
    request.raw.on('aborted', abortStream);
    raw.on('close', abortStream);
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) {
        raw.write(': ping\n\n');
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);

    try {
      for await (const event of this.assistant.stream(dto, {
        correlationId: request.tenant.correlationId,
        homeId: request.tenant.homeId,
        signal: aborted.signal,
        tenantId: request.tenant.tenantId,
        userId: request.tenant.actorUserId,
      })) {
        if (aborted.signal.aborted) {
          break;
        }
        raw.write(`event: ${event.type}\n`);
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stream-failed';
      raw.write(`event: error\ndata: ${JSON.stringify({ message, type: 'error' })}\n\n`);
    } finally {
      clearInterval(heartbeat);
      request.raw.off('aborted', abortStream);
      raw.off('close', abortStream);
      raw.end();
    }
  }
}
