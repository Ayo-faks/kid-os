import { Injectable, Logger } from '@nestjs/common';

import {
  type AssistantStreamEvent,
  type AssistantStreamProvider,
  type AssistantStreamRequest,
} from './stream-provider.js';

const DEFAULT_HERMES_CHAT_URL = 'http://hermes:8080/v1/chat/completions';
const ASSISTANT_UNAVAILABLE_MESSAGE =
  'Care Assistant is temporarily unavailable. Please try again.';

interface OpenAiDeltaChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string };
    readonly finish_reason?: string | null;
  }>;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

@Injectable()
export class HermesAssistantProvider implements AssistantStreamProvider {
  private readonly logger = new Logger(HermesAssistantProvider.name);
  private readonly chatUrl = process.env.HERMES_CHAT_URL ?? DEFAULT_HERMES_CHAT_URL;
  private readonly model = process.env.HERMES_CHAT_MODEL ?? 'careos.chat.general';

  async *stream(request: AssistantStreamRequest): AsyncIterable<AssistantStreamEvent> {
    let response: Response;
    try {
      response = await fetch(this.chatUrl, {
        body: JSON.stringify({
          messages: request.messages,
          model: this.model,
          stream: true,
        }),
        headers: {
          'content-type': 'application/json',
          'x-careos-correlation-id': request.correlationId,
          'x-careos-home-id': request.homeId,
          'x-careos-tenant-id': request.tenantId,
          'x-careos-user-id': request.userId,
        },
        method: 'POST',
        signal: request.signal,
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'hermes-unreachable');
      yield { message: ASSISTANT_UNAVAILABLE_MESSAGE, type: 'error' };
      return;
    }

    if (!response.ok || response.body === null) {
      this.logger.warn({ status: response.status }, 'hermes-unavailable');
      yield { message: ASSISTANT_UNAVAILABLE_MESSAGE, type: 'error' };
      return;
    }

    let totalTokens = 0;
    try {
      for await (const chunk of parseOpenAiSse(response.body)) {
        if (chunk.error !== undefined) {
          this.logger.warn({ code: chunk.error.code }, 'hermes-stream-error');
          yield { message: ASSISTANT_UNAVAILABLE_MESSAGE, type: 'error' };
          return;
        }
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          totalTokens += 1;
          yield { content, type: 'token' };
        }
      }
      yield { tokens: totalTokens, type: 'done' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stream-failed';
      yield { message, type: 'error' };
    }
  }
}

async function* parseOpenAiSse(body: ReadableStream<Uint8Array>): AsyncIterable<OpenAiDeltaChunk> {
  const reader = body.getReader();
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
        const data = extractDataPayload(rawEvent);
        if (data !== null && data !== '[DONE]') {
          try {
            yield JSON.parse(data) as OpenAiDeltaChunk;
          } catch {
            // Skip malformed chunks; upstream surfaces an error event if the stream stalls.
          }
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractDataPayload(rawEvent: string): string | null {
  const lines = rawEvent.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines.length === 0 ? null : dataLines.join('\n');
}
