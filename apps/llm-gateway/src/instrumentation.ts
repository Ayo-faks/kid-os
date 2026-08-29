import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk =
  process.env.OTEL_SDK_DISABLED === 'true'
    ? undefined
    : new NodeSDK({
        instrumentations: [getNodeAutoInstrumentations()],
        serviceName: process.env.OTEL_SERVICE_NAME ?? 'llm-gateway',
      });

sdk?.start();

process.once('SIGTERM', () => {
  void sdk?.shutdown().finally(() => process.exit(0));
});

export { sdk as otelSdk };
