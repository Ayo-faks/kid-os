import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryBudgetStore, buildGateway } from './server.js';
import type { GatewayConfig } from './types.js';

const CONFIG: GatewayConfig = {
  azureAiInferenceEndpoint: 'https://foundry.invalid',
  azureAiInferenceKey: 'unused',
  azureOpenAiApiKey: 'unused',
  azureOpenAiApiVersion: '2025-01-01-preview',
  azureOpenAiEndpoint: 'https://aoai.invalid',
  defaultModel: 'qwen2.5:0.5b-instruct',
  monthlyTokenBudget: 1_000,
  ollamaUrl: 'http://ollama.local:11434',
  port: 8080,
  provider: 'ollama',
  redisUrl: 'redis://redis.invalid:6379/0',
  serviceToken: 'gateway-test-token',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('llm-gateway', () => {
  it('rejects an exhausted tenant budget before calling the provider', async () => {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const now = new Date();
    const bucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const budgetStore = new MemoryBudgetStore();
    await budgetStore.addUsage(tenantId, bucket, 1);
    const upstreamFetch = vi.fn<typeof fetch>();
    const gateway = buildGateway({
      budgetStore,
      config: { ...CONFIG, monthlyTokenBudget: 1 },
      fetchImpl: upstreamFetch,
    });

    const response = await gateway.inject({
      headers: {
        'x-careos-gateway-token': 'gateway-test-token',
        'x-careos-tenant-id': tenantId,
      },
      method: 'POST',
      payload: { messages: [{ content: 'Hello', role: 'user' }] },
      url: '/v1/careos/summarize',
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'token_budget_exceeded', message: 'Monthly token budget exceeded.' },
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    await gateway.close();
  });

  it('redacts provider payloads and rehydrates structured responses', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON string body.');
      const body = JSON.parse(init.body) as {
        readonly messages: ReadonlyArray<{ readonly content: string }>;
        readonly model: string;
      };
      expect(body.model).toBe('qwen2.5:0.5b-instruct');
      expect(body.messages[0]?.content).toContain('[PERSON_1]');
      expect(body.messages[0]?.content).not.toContain('Jamie Connor');

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Factual summary for [PERSON_1].' } }],
            usage: { total_tokens: 12 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );
    });
    const gateway = buildGateway({
      budgetStore: new MemoryBudgetStore(),
      config: CONFIG,
      fetchImpl: upstreamFetch,
    });

    const response = await gateway.inject({
      headers: {
        'x-careos-gateway-token': 'gateway-test-token',
        'x-careos-tenant-id': '10000000-0000-4000-8000-000000000001',
      },
      method: 'POST',
      payload: {
        messages: [{ content: 'Summarise the record for Jamie Connor.', role: 'user' }],
      },
      url: '/v1/careos/extract-structured',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: 'Factual summary for Jamie Connor.' } }],
    });
    expect(upstreamFetch).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it('returns a structured retryable error when the provider is unavailable', async () => {
    const gateway = buildGateway({
      budgetStore: new MemoryBudgetStore(),
      config: CONFIG,
      fetchImpl: vi.fn(() => Promise.reject(new Error('connection refused'))),
    });

    const response = await gateway.inject({
      headers: {
        'x-careos-gateway-token': 'gateway-test-token',
        'x-careos-tenant-id': '10000000-0000-4000-8000-000000000001',
      },
      method: 'POST',
      payload: { messages: [{ content: 'Hello', role: 'user' }] },
      url: '/v1/careos/summarize',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'provider_unavailable',
        message: 'The configured model provider is temporarily unavailable.',
        retryable: true,
      },
    });
    await gateway.close();
  });

  it('rehydrates placeholders split across streaming deltas', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON string body.');
      const body = JSON.parse(init.body) as {
        readonly messages: ReadonlyArray<{ readonly content: string }>;
        readonly stream: boolean;
      };
      expect(body.stream).toBe(true);
      expect(body.messages[0]?.content).toBe('Provide an update for [PERSON_1].');

      return Promise.resolve(
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"Update for [PER"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"SON_1] is ready."}}],"usage":{"total_tokens":8}}\n\n',
            'data: [DONE]\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );
    });
    const gateway = buildGateway({
      budgetStore: new MemoryBudgetStore(),
      config: CONFIG,
      fetchImpl: upstreamFetch,
    });

    const response = await gateway.inject({
      headers: {
        'x-careos-gateway-token': 'gateway-test-token',
        'x-careos-tenant-id': '10000000-0000-4000-8000-000000000001',
      },
      method: 'POST',
      payload: {
        messages: [{ content: 'Provide an update for Jamie Connor.', role: 'user' }],
        stream: true,
      },
      url: '/v1/careos/chat.general',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(readStreamContent(response.body)).toBe('Update for Jamie Connor is ready.');
    expect(response.body).not.toContain('[PERSON');
    expect(response.body.match(/data: \[DONE\]/g)).toHaveLength(1);
    await gateway.close();
  });
});

function readStreamContent(body: string): string {
  let content = '';
  for (const rawEvent of body.split('\n\n')) {
    const data = rawEvent.startsWith('data: ') ? rawEvent.slice(6) : '';
    if (data.length === 0 || data === '[DONE]') continue;
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload) || !Array.isArray(payload.choices)) continue;
    const choice = payload.choices[0];
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    if (typeof choice.delta.content === 'string') content += choice.delta.content;
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
