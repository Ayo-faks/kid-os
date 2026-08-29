import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { redactPayload, rehydratePayload } from './redaction.js';
import { transformOpenAiSse } from './streaming.js';
import type { BudgetStore, GatewayConfig, GatewayTask } from './types.js';

interface BuildGatewayOptions {
  readonly budgetStore: BudgetStore;
  readonly config: GatewayConfig;
  readonly fetchImpl?: typeof fetch;
}

interface TaskParameters {
  readonly task: string;
}

const TASKS = new Set<GatewayTask>([
  'chat.general',
  'draft-email',
  'draft.high-stakes',
  'embed',
  'extract-structured',
  'narrate-rota',
  'summarize',
]);

export class MemoryBudgetStore implements BudgetStore {
  private readonly usage = new Map<string, number>();

  addUsage(tenantId: string, bucket: string, tokens: number): Promise<number> {
    const key = `${tenantId}:${bucket}`;
    const next = (this.usage.get(key) ?? 0) + tokens;
    this.usage.set(key, next);
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    this.usage.clear();
    return Promise.resolve();
  }

  getUsage(tenantId: string, bucket: string): Promise<number> {
    return Promise.resolve(this.usage.get(`${tenantId}:${bucket}`) ?? 0);
  }
}

export function buildGateway(options: BuildGatewayOptions): FastifyInstance {
  const { budgetStore, config, fetchImpl = fetch } = options;
  const app = Fastify({ logger: false });

  app.addHook('onClose', () => budgetStore.close());
  app.get('/health', () => ({ status: 'ok' }));
  app.get('/ready', () => ({ provider: config.provider, status: 'ok' }));

  app.post<{ Body: unknown; Params: TaskParameters }>(
    '/v1/careos/:task',
    async (request, reply) => {
      if (!authenticate(request, config.serviceToken)) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'Gateway authentication failed.' },
        });
      }

      const task = parseTask(request.params.task);
      if (task === null) {
        return reply.code(404).send({
          error: { code: 'task_not_found', message: 'Unknown gateway task.' },
        });
      }

      const tenantId = requiredHeader(request, 'x-careos-tenant-id');
      if (tenantId === null) {
        return reply.code(400).send({
          error: { code: 'tenant_required', message: 'x-careos-tenant-id is required.' },
        });
      }
      if (!isRecord(request.body)) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: 'A JSON object body is required.' },
        });
      }

      const bucket = budgetBucket(new Date());
      const usedTokens = await budgetStore.getUsage(tenantId, bucket);
      if (usedTokens >= config.monthlyTokenBudget) {
        return reply.code(429).send({
          error: { code: 'token_budget_exceeded', message: 'Monthly token budget exceeded.' },
        });
      }

      const streaming = task === 'chat.general' && request.body.stream === true;
      const redaction = redactPayload({
        ...request.body,
        model: modelForTask(task, config),
        stream: streaming,
      });
      const upstream = upstreamForTask(task, config);
      const aborted = new AbortController();
      const abortUpstream = () => aborted.abort();
      request.raw.once('aborted', abortUpstream);

      let response: Response;
      try {
        response = await fetchImpl(upstream.url, {
          body: JSON.stringify(redaction.payload),
          headers: {
            ...upstream.headers,
            'content-type': 'application/json',
            ...contextHeaders(request),
          },
          method: 'POST',
          signal: aborted.signal,
        });
      } catch {
        request.raw.off('aborted', abortUpstream);
        return providerUnavailable(reply);
      }

      if (!response.ok) {
        request.raw.off('aborted', abortUpstream);
        return providerUnavailable(reply);
      }

      if (streaming) {
        if (response.body === null) {
          request.raw.off('aborted', abortUpstream);
          return providerUnavailable(reply);
        }
        const stream = Readable.from(
          transformOpenAiSse(response.body, {
            onComplete: async (tokens) => {
              request.raw.off('aborted', abortUpstream);
              await budgetStore.addUsage(tenantId, bucket, tokens);
            },
            tokenToOriginal: redaction.tokenToOriginal,
          }),
        );
        return reply
          .code(200)
          .headers({
            'cache-control': 'no-cache, no-transform',
            'content-type': 'text/event-stream; charset=utf-8',
            'x-accel-buffering': 'no',
          })
          .send(stream);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        request.raw.off('aborted', abortUpstream);
        return providerUnavailable(reply);
      }

      request.raw.off('aborted', abortUpstream);
      await budgetStore.addUsage(tenantId, bucket, readTotalTokens(payload));
      return reply.code(200).send(rehydratePayload(payload, redaction.tokenToOriginal));
    },
  );

  return app;
}

function parseTask(value: string): GatewayTask | null {
  return TASKS.has(value as GatewayTask) ? (value as GatewayTask) : null;
}

function authenticate(request: FastifyRequest, expected: string): boolean {
  const actual = requiredHeader(request, 'x-careos-gateway-token');
  if (actual === null || expected.length === 0) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requiredHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function contextHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    'x-careos-correlation-id',
    'x-careos-home-id',
    'x-careos-tenant-id',
    'x-careos-user-id',
  ]) {
    const value = requiredHeader(request, name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

function modelForTask(_task: GatewayTask, config: GatewayConfig): string {
  return config.defaultModel;
}

function upstreamForTask(
  task: GatewayTask,
  config: GatewayConfig,
): { readonly headers: Record<string, string>; readonly url: string } {
  const isEmbedding = task === 'embed';
  if (config.provider === 'ollama') {
    return {
      headers: {},
      url: `${config.ollamaUrl.replace(/\/$/, '')}/v1/${isEmbedding ? 'embeddings' : 'chat/completions'}`,
    };
  }

  if (config.provider === 'azure-openai') {
    const operation = isEmbedding ? 'embeddings' : 'chat/completions';
    return {
      headers: { 'api-key': config.azureOpenAiApiKey },
      url:
        `${config.azureOpenAiEndpoint.replace(/\/$/, '')}/openai/deployments/` +
        `${encodeURIComponent(modelForTask(task, config))}/${operation}` +
        `?api-version=${encodeURIComponent(config.azureOpenAiApiVersion)}`,
    };
  }

  return {
    headers: { 'api-key': config.azureAiInferenceKey },
    url: `${config.azureAiInferenceEndpoint.replace(/\/$/, '')}/models/${
      isEmbedding ? 'embeddings' : 'chat/completions'
    }`,
  };
}

function providerUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'provider_unavailable',
      message: 'The configured model provider is temporarily unavailable.',
      retryable: true,
    },
  });
}

function budgetBucket(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readTotalTokens(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.usage)) return 0;
  const value = payload.usage.total_tokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
