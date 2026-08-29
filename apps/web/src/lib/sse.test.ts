import { describe, expect, it } from 'vitest';

import { streamSse, type AssistantStreamEvent } from './sse';

function sseResponse(chunks: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

describe('streamSse', () => {
  it('parses multi-event SSE payload into typed events', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        sseResponse([
          'event: token\ndata: {"type":"token","content":"hi "}\n\n',
          'event: token\ndata: {"type":"token","content":"there"}\n\n',
          'event: done\ndata: {"type":"done","tokens":2}\n\n',
        ]),
      );

    try {
      const events: AssistantStreamEvent[] = [];
      for await (const event of streamSse({ body: {}, url: '/x' })) {
        events.push(event);
      }
      expect(events).toEqual([
        { content: 'hi ', type: 'token' },
        { content: 'there', type: 'token' },
        { tokens: 2, type: 'done' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ignores stream-open and heartbeat comments', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        sseResponse([
          ': stream-open\n\n',
          ': ping\n\n',
          'event: token\ndata: {"type":"token","content":"ready"}\n\n',
          ': ping\n\n',
          'event: done\ndata: {"type":"done","tokens":1}\n\n',
        ]),
      );

    try {
      const events: AssistantStreamEvent[] = [];
      for await (const event of streamSse({ body: {}, url: '/x' })) {
        events.push(event);
      }
      expect(events).toEqual([
        { content: 'ready', type: 'token' },
        { tokens: 1, type: 'done' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits an error event on non-200 responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response('boom', { status: 500 }));
    try {
      const events: AssistantStreamEvent[] = [];
      for await (const event of streamSse({ body: {}, url: '/x' })) {
        events.push(event);
      }
      expect(events[0]?.type).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
