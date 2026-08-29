import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startWorkerHealthServer } from './worker-health.js';

const servers = new Set<ReturnType<typeof startWorkerHealthServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  servers.clear();
});

describe('worker health server', () => {
  it('serves only the health endpoint', async () => {
    const server = startWorkerHealthServer(0);
    servers.add(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const other = await fetch(`http://127.0.0.1:${port}/`);

    expect(health.status).toBe(200);
    await expect(health.text()).resolves.toBe('ok');
    expect(other.status).toBe(404);
  });

  it('supports a bodyless health probe', async () => {
    const server = startWorkerHealthServer(0);
    servers.add(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });
});
