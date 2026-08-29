import type { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LlmRouterService } from './llm-router.service.js';

describe('LlmRouterService PII redaction', () => {
  it('redacts PII before the gateway call and rehydrates the caller response', async () => {
    const prompt =
      'Jamie Connor was born on 1999-03-04. NHS 123 456 7890. Address: 12 Oak Street, Manchester.';
    const post = vi.fn((url: string, payload: Record<string, unknown>, config: unknown) => {
      expect(url).toBe('http://llm-gateway:8080/v1/careos/extract-structured');
      expect(config).toMatchObject({
        headers: {
          'x-careos-correlation-id': 'corr-1',
          'x-careos-gateway-token': 'change-me',
          'x-careos-home-id': 'home-1',
          'x-careos-tenant-id': 'tenant-1',
        },
      });
      expect(config).not.toMatchObject({
        headers: {
          'x-careos-model-deployment': expect.anything(),
          'x-careos-model-provider': expect.anything(),
        },
      });

      const outbound = JSON.stringify(payload);
      expect(outbound).not.toContain('Jamie Connor');
      expect(outbound).not.toContain('1999-03-04');
      expect(outbound).not.toContain('NHS 123 456 7890');
      expect(outbound).not.toContain('12 Oak Street, Manchester');
      expect(outbound).toContain('[PERSON_1]');
      expect(outbound).toContain('[DATE_1]');
      expect(outbound).toContain('[NHS_1]');
      expect(outbound).toContain('[ADDRESS_1]');

      return of({
        data: {
          extracted: {
            address: '[ADDRESS_1]',
            dateOfBirth: '[DATE_1]',
            name: '[PERSON_1]',
            nhsNumber: '[NHS_1]',
          },
          summary: 'Draft for [PERSON_1] born [DATE_1], identifier [NHS_1], living at [ADDRESS_1].',
        },
      });
    });
    const service = new LlmRouterService({ post } as unknown as HttpService);

    const response = await service.forward(
      'extract-structured',
      {
        input: prompt,
        messages: [{ content: prompt, role: 'user' }],
      },
      { correlationId: 'corr-1', homeId: 'home-1', tenantId: 'tenant-1' },
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      extracted: {
        address: '12 Oak Street, Manchester',
        dateOfBirth: '1999-03-04',
        name: 'Jamie Connor',
        nhsNumber: 'NHS 123 456 7890',
      },
      summary:
        'Draft for Jamie Connor born 1999-03-04, identifier NHS 123 456 7890, living at 12 Oak Street, Manchester.',
    });
  });
});
