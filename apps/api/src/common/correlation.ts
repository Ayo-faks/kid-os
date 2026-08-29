import { randomUUID } from 'node:crypto';

import { type FastifyRequest } from 'fastify';

import { firstHeader } from './request-context.js';

export function getCorrelationId(request: FastifyRequest): string {
  const explicitCorrelationId = firstHeader(request, 'x-correlation-id');

  if (explicitCorrelationId !== undefined && explicitCorrelationId.length > 0) {
    return explicitCorrelationId;
  }

  const traceparent = firstHeader(request, 'traceparent');
  const traceId = traceparent?.split('-')[1];

  if (traceId !== undefined && /^[a-f0-9]{32}$/i.test(traceId)) {
    return traceId;
  }

  return randomUUID();
}
