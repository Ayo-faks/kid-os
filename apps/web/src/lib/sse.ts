export type AssistantStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'done'; tokens: number }
  | { type: 'error'; message: string };

export interface StreamSseOptions {
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly url: string;
}

export async function* streamSse(
  options: StreamSseOptions,
): AsyncGenerator<AssistantStreamEvent, void, void> {
  const response = await fetch(options.url, {
    body: JSON.stringify(options.body),
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    method: 'POST',
    signal: options.signal,
  });

  if (!response.ok || response.body === null) {
    yield { message: `assistant.stream HTTP ${response.status}`, type: 'error' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length > 0) {
          try {
            yield JSON.parse(dataLines.join('\n')) as AssistantStreamEvent;
          } catch {
            // Skip malformed payloads.
          }
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
