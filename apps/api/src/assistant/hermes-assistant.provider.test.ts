import { afterEach, describe, expect, it, vi } from 'vitest';

import { HermesAssistantProvider } from './hermes-assistant.provider.js';
import type { AssistantStreamEvent, AssistantStreamRequest } from './stream-provider.js';

const REQUEST: AssistantStreamRequest = {
  correlationId: 'corr-chat-unavailable',
  homeId: '20000000-0000-4000-8000-00000000000a',
  messages: [{ content: 'Summarise the incident record requirements.', role: 'user' }],
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '30000000-0000-4000-8000-000000000006',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HermesAssistantProvider', () => {
  it('emits one explicit error event when Hermes is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused'))),
    );
    const provider = new HermesAssistantProvider();

    const events: AssistantStreamEvent[] = [];
    for await (const event of provider.stream(REQUEST)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        message: 'Care Assistant is temporarily unavailable. Please try again.',
        type: 'error',
      },
    ]);
  });

  it('forwards authenticated context and the abort signal to Hermes', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('http://hermes:8080/v1/chat/completions');
      expect(init?.headers).toMatchObject({
        'x-careos-correlation-id': REQUEST.correlationId,
        'x-careos-home-id': REQUEST.homeId,
        'x-careos-tenant-id': REQUEST.tenantId,
        'x-careos-user-id': REQUEST.userId,
      });
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"A factual reply."}}]}\n\n' + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HermesAssistantProvider();

    const events: AssistantStreamEvent[] = [];
    for await (const event of provider.stream({ ...REQUEST, signal: controller.signal })) {
      events.push(event);
    }

    expect(events).toEqual([
      { content: 'A factual reply.', type: 'token' },
      { tokens: 1, type: 'done' },
    ]);
  });

  it('terminates with an error event when the upstream stream reports failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            'data: {"error":{"code":"provider_unavailable","message":"upstream closed"}}\n\n',
            { headers: { 'content-type': 'text/event-stream' }, status: 200 },
          ),
        ),
      ),
    );
    const provider = new HermesAssistantProvider();

    const events: AssistantStreamEvent[] = [];
    for await (const event of provider.stream(REQUEST)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        message: 'Care Assistant is temporarily unavailable. Please try again.',
        type: 'error',
      },
    ]);
  });
});
