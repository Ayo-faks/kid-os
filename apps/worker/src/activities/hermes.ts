import { randomUUID } from 'node:crypto';

export const DEFAULT_HERMES_URL = 'http://hermes:8080';

export interface HelloHermesInput {
  readonly message?: string;
}

export interface HelloHermesResult {
  readonly body: string;
  readonly hermesUrl: string;
  readonly message: string;
  readonly status: number;
}

export async function helloHermes(input: HelloHermesInput = {}): Promise<HelloHermesResult> {
  const hermesUrl = process.env.HERMES_URL ?? DEFAULT_HERMES_URL;
  const healthUrl = new URL('/health', hermesUrl);
  const response = await fetch(healthUrl, {
    headers: {
      accept: 'text/plain, application/json',
    },
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`Hermes health check failed with ${response.status} ${response.statusText}`);
  }

  const body = await response.text();

  return {
    body: body.slice(0, 512),
    hermesUrl,
    message: input.message ?? 'hello from Temporal',
    status: response.status,
  };
}

export async function callHermesTool<TPayload extends Record<string, unknown>>(
  name: string,
  argumentsPayload: Record<string, unknown>,
  options: {
    readonly correlationId?: string;
    readonly homeId?: string;
    readonly tenantId?: string;
    readonly userId?: string;
  } = {},
): Promise<TPayload> {
  const hermesUrl = process.env.HERMES_URL ?? DEFAULT_HERMES_URL;
  const response = await fetch(new URL('/mcp', hermesUrl), {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: argumentsPayload,
        name,
      },
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.correlationId ? { 'x-careos-correlation-id': options.correlationId } : {}),
      ...(options.homeId ? { 'x-careos-home-id': options.homeId } : {}),
      ...(options.tenantId ? { 'x-careos-tenant-id': options.tenantId } : {}),
      ...(options.userId ? { 'x-careos-user-id': options.userId } : {}),
    },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Hermes tool ${name} failed with ${response.status} ${response.statusText}`);
  }

  const envelope = await response.json();
  if (!isRecord(envelope)) {
    throw new Error(`Hermes tool ${name} returned a non-object response.`);
  }

  const error = envelope.error;
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : 'Unknown Hermes error.';
    throw new Error(`Hermes tool ${name} failed: ${message}`);
  }

  const result = envelope.result;
  if (!isRecord(result)) {
    throw new Error(`Hermes tool ${name} returned no result.`);
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error(`Hermes tool ${name} returned no content.`);
  }

  const textItem = content.find(
    (item): item is { readonly text: string; readonly type: string } => {
      if (!isRecord(item)) return false;
      return item.type === 'text' && typeof item.text === 'string';
    },
  );
  if (!textItem) {
    throw new Error(`Hermes tool ${name} returned no text content.`);
  }

  const payload: unknown = JSON.parse(textItem.text);
  if (!isRecord(payload)) {
    throw new Error(`Hermes tool ${name} returned non-object JSON content.`);
  }

  return payload as TPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
