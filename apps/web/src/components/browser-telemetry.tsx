'use client';

import { ZoneContextManager } from '@opentelemetry/context-zone';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { useEffect } from 'react';

let isRegistered = false;

export function BrowserTelemetry() {
  useEffect(() => {
    if (isRegistered || process.env.NEXT_PUBLIC_OTEL_SDK_DISABLED === 'true') {
      return;
    }

    isRegistered = true;

    const exporter = new OTLPTraceExporter({
      url: process.env.NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT ?? '/otel/v1/traces',
    });
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'web' }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    provider.register({ contextManager: new ZoneContextManager() });
    registerInstrumentations({ instrumentations: [new FetchInstrumentation()] });

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (apiBaseUrl !== undefined && apiBaseUrl.length > 0) {
      void fetch(new URL('observability/trace', `${apiBaseUrl.replace(/\/$/, '')}/`), {
        headers: { 'x-careos-trace-probe': 'browser' },
      }).catch(() => undefined);
    }
  }, []);

  return null;
}
