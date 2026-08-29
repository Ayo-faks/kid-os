import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

import type { MattermostProvider } from '../comms/mattermost-provider.js';

import { __setMattermostProviderForTests, postMattermostMessage } from './mattermost.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const correlationId = 'corr-mm-test';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

describe('postMattermostMessage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    __setMattermostProviderForTests(undefined);
  });

  it('returns channel-mapping-missing when no row exists for the kind', async () => {
    const provider = stubProvider('disabled', {
      delivered: false,
      providerMessageId: null,
      reason: 'mattermost-disabled',
    });
    __setMattermostProviderForTests(provider);
    const query = mockTenantClient([{ rows: [], rowCount: 0 }]);

    const result = await postMattermostMessage({
      actor,
      channelKind: 'safeguarding',
      homeId,
      message: 'hello',
      tenantId,
    });

    expect(result).toEqual({
      channelId: null,
      delivered: false,
      providerKind: 'disabled',
      providerMessageId: null,
      reason: 'channel-mapping-missing:safeguarding',
    });
    expect(provider.postToChannel).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('dispatches via the provider when a mapping is found', async () => {
    const provider = stubProvider('http', { delivered: true, providerMessageId: 'post-77' });
    __setMattermostProviderForTests(provider);
    mockTenantClient([{ rows: [{ channel_id: 'channel-abc' }], rowCount: 1 }]);

    const result = await postMattermostMessage({
      actor,
      channelKind: 'home',
      deliveryId: 'shift-reminder:33333333-3333-4333-8333-333333333333',
      homeId,
      message: 'shift starting in 30m',
      tenantId,
    });

    expect(provider.postToChannel).toHaveBeenCalledWith({
      channelId: 'channel-abc',
      correlationId,
      message: 'shift starting in 30m',
      pendingPostId: createHash('sha256')
        .update('shift-reminder:33333333-3333-4333-8333-333333333333')
        .digest('hex')
        .slice(0, 26),
    });
    expect(result).toEqual({
      channelId: 'channel-abc',
      delivered: true,
      providerKind: 'http',
      providerMessageId: 'post-77',
      reason: undefined,
    });
  });

  it('propagates a provider failure reason without throwing', async () => {
    const provider = stubProvider('http', {
      delivered: false,
      providerMessageId: null,
      reason: 'http-503',
    });
    __setMattermostProviderForTests(provider);
    mockTenantClient([{ rows: [{ channel_id: 'channel-xyz' }], rowCount: 1 }]);

    const result = await postMattermostMessage({
      actor,
      channelKind: 'rota',
      homeId,
      message: 'rota updated',
      tenantId,
    });

    expect(result).toEqual({
      channelId: 'channel-xyz',
      delivered: false,
      providerKind: 'http',
      providerMessageId: null,
      reason: 'http-503',
    });
  });
});

function stubProvider(
  kind: 'disabled' | 'http',
  result: {
    readonly delivered: boolean;
    readonly providerMessageId: string | null;
    readonly reason?: string;
  },
): MattermostProvider & { postToChannel: ReturnType<typeof vi.fn> } {
  const postToChannel = vi.fn().mockResolvedValue(result);
  return { kind, postToChannel };
}

function mockTenantClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }

  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}
