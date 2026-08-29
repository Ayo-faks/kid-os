import { describe, expect, it, vi } from 'vitest';

import { connectToTemporal } from './temporal-readiness.js';

describe('connectToTemporal', () => {
  it('keeps the process alive until Temporal accepts a connection', async () => {
    const connection = { kind: 'native' };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(connection);
    const wait = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(
      connectToTemporal({ address: 'temporal:7233', connect, delayMs: 25, onRetry, wait }),
    ).resolves.toEqual({ attempts: 3, connection });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
    expect(wait).toHaveBeenNthCalledWith(2, 25);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive retry delay', async () => {
    await expect(
      connectToTemporal({
        address: 'temporal:7233',
        connect: vi.fn(),
        delayMs: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
