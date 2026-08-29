interface OpenAiChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  }>;
  readonly usage?: { readonly total_tokens?: number; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

interface StreamTransformOptions {
  readonly onComplete: (tokens: number) => Promise<void>;
  readonly tokenToOriginal: ReadonlyMap<string, string>;
}

export async function* transformOpenAiSse(
  body: ReadableStream<Uint8Array>,
  options: StreamTransformOptions,
): AsyncGenerator<string, void, void> {
  const rehydrator = new StreamingPlaceholderRehydrator(options.tokenToOriginal);
  let totalTokens = 0;

  for await (const data of readSseData(body)) {
    if (data === '[DONE]') continue;

    const chunk = parseChunk(data);
    if (chunk === null) continue;

    totalTokens = Math.max(totalTokens, positiveInteger(chunk.usage?.total_tokens));
    const rewritten = rewriteChunkContent(chunk, rehydrator);
    yield `data: ${JSON.stringify(rewritten)}\n\n`;
  }

  const trailing = rehydrator.flush();
  if (trailing.length > 0) yield encodeContentChunk(trailing);
  await options.onComplete(totalTokens);
  yield 'data: [DONE]\n\n';
}

class StreamingPlaceholderRehydrator {
  private pending = '';
  private readonly entries: ReadonlyArray<readonly [string, string]>;

  constructor(tokenToOriginal: ReadonlyMap<string, string>) {
    this.entries = [...tokenToOriginal.entries()].sort(
      ([left], [right]) => right.length - left.length,
    );
  }

  push(value: string): string {
    this.pending += value;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = '';

    while (this.pending.length > 0) {
      const bracketIndex = this.pending.indexOf('[');
      if (bracketIndex === -1) {
        output += this.pending;
        this.pending = '';
        break;
      }
      if (bracketIndex > 0) {
        output += this.pending.slice(0, bracketIndex);
        this.pending = this.pending.slice(bracketIndex);
        continue;
      }

      const complete = this.entries.find(([token]) => this.pending.startsWith(token));
      if (complete !== undefined) {
        output += complete[1];
        this.pending = this.pending.slice(complete[0].length);
        continue;
      }

      const possiblePrefix = this.entries.some(([token]) => token.startsWith(this.pending));
      if (possiblePrefix && !final) break;

      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }

    return output;
  }
}

function rewriteChunkContent(
  chunk: OpenAiChunk,
  rehydrator: StreamingPlaceholderRehydrator,
): OpenAiChunk {
  if (chunk.choices === undefined) return chunk;
  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      const content = choice.delta?.content;
      if (typeof content !== 'string') return choice;
      return {
        ...choice,
        delta: { ...choice.delta, content: rehydrator.push(content) },
      };
    }),
  };
}

function encodeContentChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`;
}

function parseChunk(value: string): OpenAiChunk | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      const events = takeCompleteEvents(buffer);
      buffer = events.remainder;
      for (const event of events.values) {
        const data = extractData(event);
        if (data !== null) yield data;
      }
    }

    const trailing = extractData(buffer.trim());
    if (trailing !== null) yield trailing;
  } finally {
    if (!completed) {
      try {
        await reader.cancel('downstream-closed');
      } catch {
        // The upstream may already have closed while cancellation propagated.
      }
    }
    reader.releaseLock();
  }
}

function takeCompleteEvents(buffer: string): {
  readonly remainder: string;
  readonly values: readonly string[];
} {
  const values: string[] = [];
  let remainder = buffer;
  let separator = remainder.indexOf('\n\n');
  while (separator !== -1) {
    values.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 2);
    separator = remainder.indexOf('\n\n');
  }
  return { remainder, values };
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return lines.length === 0 ? null : lines.join('\n');
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
