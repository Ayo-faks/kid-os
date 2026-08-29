import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpMattermostProvider } from './mattermost-provider.js';

describe('HttpMattermostProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes a retry-stable pending post ID to Mattermost', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ id: 'post-77' }),
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpMattermostProvider({
      baseUrl: 'https://mattermost.example.test',
      botToken: 'test-token',
    });

    await expect(
      provider.postToChannel({
        channelId: 'channel-abc',
        correlationId: 'corr-mm-test',
        message: 'shift starting in 30m',
        pendingPostId: 'a'.repeat(26),
      }),
    ).resolves.toEqual({ delivered: true, providerMessageId: 'post-77' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mattermost.example.test/api/v4/posts',
      expect.objectContaining({
        body: JSON.stringify({
          channel_id: 'channel-abc',
          message: 'shift starting in 30m',
          pending_post_id: 'a'.repeat(26),
          props: { careos_correlation_id: 'corr-mm-test' },
        }),
      }),
    );
  });
});
