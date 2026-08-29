import { Controller, Get, Headers } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { trace } from '@opentelemetry/api';

import { Public } from '../common/public.decorator.js';

interface TraceProbeResponse {
  readonly source: string;
  readonly status: 'ok';
  readonly traceId: string;
}

@ApiTags('observability')
@Public()
@Controller('observability')
export class ObservabilityController {
  private readonly tracer = trace.getTracer('careos-api-observability');

  @Get('trace')
  @ApiOkResponse({ description: 'Emits a Phase 0 trace probe span.' })
  traceProbe(
    @Headers('x-careos-trace-probe') sourceHeader: string | undefined,
  ): TraceProbeResponse {
    const source = sourceHeader ?? 'unknown';

    return this.tracer.startActiveSpan('careos.phase0.trace_probe', (span) => {
      span.setAttribute('careos.trace_probe.source', source);
      const traceId = span.spanContext().traceId;
      span.end();

      return { source, status: 'ok' as const, traceId };
    });
  }
}
