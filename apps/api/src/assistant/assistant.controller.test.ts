import { EventEmitter } from 'node:events';

import { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { type AssistantStreamEvent, type AssistantStreamProvider } from './stream-provider.js';

class GatedProvider implements AssistantStreamProvider {
  private release: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  open(): void {
    this.release?.();
  }

  async *stream(): AsyncIterable<AssistantStreamEvent> {
    await this.gate;
    yield { content: 'ok', type: 'token' };
    yield { tokens: 1, type: 'done' };
  }
}

class FakeRaw extends EventEmitter {
  public statusCode = 0;
  public writableEnded = false;
  public readonly chunks: string[] = [];

  body(): string {
    return this.chunks.join('');
  }

  end(): void {
    this.writableEnded = true;
  }

  flushHeaders(): void {}

  setHeader(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function makeRequest(): FastifyRequest {
  return {
    auth: {
      homeIds: ['home-1'],
      roles: ['support_worker'],
      sub: 'user-sub',
      tenantId: 'tenant-1',
    },
    raw: new EventEmitter(),
    tenant: {
      actorUserId: 'user-1',
      correlationId: 'corr-1',
      homeId: 'home-1',
      roles: ['support_worker'],
      tenantId: 'tenant-1',
      userSub: 'user-sub',
    },
  } as unknown as FastifyRequest;
}

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('AssistantController SSE transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the stream immediately and heartbeats until the first provider event', async () => {
    const provider = new GatedProvider();
    const controller = new AssistantController(new AssistantService(provider));
    const raw = new FakeRaw();
    const request = makeRequest();
    const reply = { raw } as unknown as FastifyReply;

    const pending = controller.messages({ message: 'Hello' }, request, reply);

    await vi.advanceTimersByTimeAsync(0);
    // A comment byte must hit the wire before the provider produces anything,
    // otherwise intermediaries (undici bodyTimeout, proxies) abort slow
    // generations and the client sees a bogus 502.
    expect(raw.body()).toContain(': stream-open\n\n');
    expect(raw.body()).not.toContain('event:');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(countOf(raw.body(), ': ping\n\n')).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(countOf(raw.body(), ': ping\n\n')).toBe(3);

    provider.open();
    await pending;

    expect(raw.body()).toContain('event: token\n');
    expect(raw.body()).toContain('"content":"ok"');
    expect(raw.body()).toContain('event: done\n');
    expect(raw.writableEnded).toBe(true);

    const pingsAtEnd = countOf(raw.body(), ': ping\n\n');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(countOf(raw.body(), ': ping\n\n')).toBe(pingsAtEnd);
  });
});
