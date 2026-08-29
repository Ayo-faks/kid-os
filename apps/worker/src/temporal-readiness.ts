import { setTimeout as wait } from 'node:timers/promises';

export interface ConnectToTemporalOptions<Connection> {
  readonly address: string;
  readonly connect: (address: string) => Promise<Connection>;
  readonly delayMs?: number;
  readonly onRetry?: (attempt: number, error: unknown) => void;
  readonly wait?: (delayMs: number) => Promise<unknown>;
}

export interface TemporalConnectionResult<Connection> {
  readonly attempts: number;
  readonly connection: Connection;
}

export async function connectToTemporal<Connection>(
  options: ConnectToTemporalOptions<Connection>,
): Promise<TemporalConnectionResult<Connection>> {
  const delayMs = options.delayMs ?? 5_000;
  if (!Number.isInteger(delayMs) || delayMs <= 0) {
    throw new Error('Temporal connection retry delay must be a positive integer');
  }
  const waitForDelay = options.wait ?? wait;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const connection = await options.connect(options.address);
      return { attempts: attempt, connection };
    } catch (error) {
      options.onRetry?.(attempt, error);
      await waitForDelay(delayMs);
    }
  }
}
