import { afterEach, describe, expect, it, vi } from 'vitest';

import { callHermesTool, helloHermes } from './hermes.js';

const originalFetch = globalThis.fetch;

describe('helloHermes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('pings the Hermes health endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HERMES_URL', 'http://hermes.local:8080');

    await expect(helloHermes({ message: 'ping' })).resolves.toEqual({
      body: 'ok',
      hermesUrl: 'http://hermes.local:8080',
      message: 'ping',
      status: 200,
    });

    expect(fetchMock).toHaveBeenCalledWith(new URL('http://hermes.local:8080/health'), {
      headers: {
        accept: 'text/plain, application/json',
      },
      method: 'GET',
    });
  });

  it('raises when Hermes is unhealthy', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(helloHermes()).rejects.toThrow(
      'Hermes health check failed with 503 Service Unavailable',
    );
  });
});

describe('callHermesTool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('parses JSON text content from a Hermes tool result', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id: 'rpc-1',
          jsonrpc: '2.0',
          result: {
            content: [{ text: '{"ok":true}', type: 'text' }],
            isError: false,
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HERMES_URL', 'http://hermes.local:8080');

    await expect(
      callHermesTool(
        'list_form_templates',
        {},
        {
          correlationId: 'corr-1',
          homeId: 'home-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      ),
    ).resolves.toEqual({
      ok: true,
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-careos-correlation-id')).toBe('corr-1');
    expect(headers.get('x-careos-home-id')).toBe('home-1');
    expect(headers.get('x-careos-tenant-id')).toBe('tenant-1');
    expect(headers.get('x-careos-user-id')).toBe('user-1');
  });
});
