import { describe, expect, it, vi } from 'vitest';

import { transformOpenAiSse } from './streaming.js';

describe('transformOpenAiSse', () => {
  it('cancels the upstream reader when the downstream consumer stops', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first token"}}]}\n\n'),
        );
      },
    });
    const transformed = transformOpenAiSse(body, {
      onComplete: vi.fn(() => Promise.resolve()),
      tokenToOriginal: new Map(),
    });

    await expect(transformed.next()).resolves.toMatchObject({ done: false });
    await transformed.return();

    expect(cancel).toHaveBeenCalledWith('downstream-closed');
  });
});
