import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

export type LlmTask =
  | 'chat.general'
  | 'draft.high-stakes'
  | 'embed'
  | 'extract-structured'
  | 'summarize';

@Injectable()
export class LlmRouterService {
  private readonly gatewayUrl = process.env.LLM_GATEWAY_URL ?? 'http://llm-gateway:8080';
  private readonly gatewayToken = process.env.LLM_GATEWAY_SERVICE_TOKEN ?? 'change-me';

  constructor(private readonly http: HttpService) {}

  async forward<TResponse extends Record<string, unknown>>(
    task: LlmTask,
    payload: Record<string, unknown>,
    context: { readonly correlationId: string; readonly homeId: string; readonly tenantId: string },
  ): Promise<TResponse> {
    const redaction = redactPayload(payload);
    const response = await firstValueFrom(
      this.http.post<TResponse>(`${this.gatewayUrl}/v1/careos/${task}`, redaction.payload, {
        headers: {
          'x-careos-correlation-id': context.correlationId,
          'x-careos-gateway-token': this.gatewayToken,
          'x-careos-home-id': context.homeId,
          'x-careos-tenant-id': context.tenantId,
        },
      }),
    );

    return rehydratePayload(response.data, redaction.tokenToOriginal) as TResponse;
  }
}

type PiiKind = 'ADDRESS' | 'DATE' | 'NHS' | 'PERSON';

interface RedactionResult {
  readonly payload: Record<string, unknown>;
  readonly tokenToOriginal: ReadonlyMap<string, string>;
}

interface RedactionState {
  readonly counters: Map<PiiKind, number>;
  readonly originalToToken: Map<string, string>;
  readonly tokenToOriginal: Map<string, string>;
}

const piiPatterns: readonly { readonly kind: PiiKind; readonly pattern: RegExp }[] = [
  { kind: 'NHS', pattern: /\bNHS\s+\d{3}\s+\d{3}\s+\d{4}\b/gi },
  { kind: 'DATE', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  {
    kind: 'ADDRESS',
    pattern:
      /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|Road|Avenue|Lane|Drive|Close|Way),\s*[A-Z][A-Za-z]+(?:\s+[A-Z][a-z]+)*\b/g,
  },
  { kind: 'PERSON', pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g },
];

function redactPayload(payload: Record<string, unknown>): RedactionResult {
  const state: RedactionState = {
    counters: new Map(),
    originalToToken: new Map(),
    tokenToOriginal: new Map(),
  };

  return {
    payload: redactUnknown(payload, state) as Record<string, unknown>,
    tokenToOriginal: state.tokenToOriginal,
  };
}

function redactUnknown(value: unknown, state: RedactionState): unknown {
  if (typeof value === 'string') {
    return redactString(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, state));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, state)]),
    );
  }
  return value;
}

function redactString(value: string, state: RedactionState): string {
  let output = value;
  for (const { kind, pattern } of piiPatterns) {
    output = output.replace(pattern, (match) => tokenFor(kind, match, state));
  }
  return output;
}

function tokenFor(kind: PiiKind, original: string, state: RedactionState): string {
  const existing = state.originalToToken.get(original);
  if (existing !== undefined) {
    return existing;
  }

  const next = (state.counters.get(kind) ?? 0) + 1;
  state.counters.set(kind, next);
  const token = `[${kind}_${next}]`;
  state.originalToToken.set(original, token);
  state.tokenToOriginal.set(token, original);
  return token;
}

function rehydratePayload(value: unknown, tokenToOriginal: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return rehydrateString(value, tokenToOriginal);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rehydratePayload(item, tokenToOriginal));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rehydratePayload(item, tokenToOriginal)]),
    );
  }
  return value;
}

function rehydrateString(value: string, tokenToOriginal: ReadonlyMap<string, string>): string {
  let output = value;
  for (const [token, original] of tokenToOriginal) {
    output = output.split(token).join(original);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
