import { afterEach, describe, expect, it, vi } from 'vitest';

import { summarizeHandover, validateHandover } from './handovers.js';
import { dispatchHandoverNotifications } from './novu.js';

const originalFetch = globalThis.fetch;

describe('handover activities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('calls the Hermes summarize_handover tool and normalizes required fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id: 'rpc-1',
          jsonrpc: '2.0',
          result: {
            content: [
              {
                text: JSON.stringify({
                  confidence: 0.88,
                  form_data: {
                    endedAt: '2026-05-17T20:00:00.000Z',
                    narrative: 'Night shift notes were calm.',
                    residentsRequiringFollowUp: [],
                  },
                  missing_mandatory: [],
                  summary: 'Calm shift with no urgent follow-up.',
                }),
                type: 'text',
              },
            ],
            isError: false,
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HERMES_URL', 'http://hermes.local:8080');

    const result = await summarizeHandover({
      correlationId: 'corr-1',
      freeText: 'Night shift notes were calm.',
      homeId: '22222222-2222-4222-8222-222222222222',
      shiftId: '33333333-3333-4333-8333-333333333333',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toMatchObject({
      confidence: 0.88,
      formData: {
        endedAt: '2026-05-17T20:00:00.000Z',
        narrative: 'Night shift notes were calm.',
        shiftId: '33333333-3333-4333-8333-333333333333',
      },
      missingMandatory: [],
      summary: 'Calm shift with no urgent follow-up.',
    });
    expect(result.promptHash).toMatch(/^[a-f0-9]{64}$/);

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    const request = JSON.parse(body as string) as {
      readonly params?: { readonly name?: string };
    };
    expect(request.params?.name).toBe('summarize_handover');
  });

  it('validates handover.shift-end.v1 mandatory fields', async () => {
    await expect(
      validateHandover({
        formData: {
          endedAt: '2026-05-17T20:00:00.000Z',
          narrative: 'Night shift notes were calm.',
          shiftId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    ).resolves.toMatchObject({ valid: true });

    await expect(
      validateHandover({
        formData: {
          narrative: 'Too little structure.',
          shiftId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    ).resolves.toMatchObject({ missingMandatory: ['endedAt'], valid: false });
  });

  it('does not enqueue Novu outbox rows when the provider is disabled', async () => {
    vi.stubEnv('NOVU_PROVIDER', 'disabled');

    await expect(
      dispatchHandoverNotifications({
        actor: {
          correlationId: 'corr-1',
          kind: 'user',
          userId: '44444444-4444-4444-8444-444444444444',
        },
        assigneeUserIds: ['55555555-5555-4555-8555-555555555555'],
        handoverId: '66666666-6666-4666-8666-666666666666',
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        taskIds: ['77777777-7777-4777-8777-777777777777'],
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual({ dispatched: false });
  });
});
