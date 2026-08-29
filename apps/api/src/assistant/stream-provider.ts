export type AssistantStreamEvent =
  | { readonly type: 'token'; readonly content: string }
  | { readonly type: 'done'; readonly tokens: number }
  | { readonly type: 'error'; readonly message: string };

export interface AssistantChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AssistantStreamRequest {
  readonly correlationId: string;
  readonly homeId: string;
  readonly messages: readonly AssistantChatMessage[];
  readonly signal?: AbortSignal;
  readonly tenantId: string;
  readonly userId: string;
}

export interface AssistantStreamProvider {
  stream(request: AssistantStreamRequest): AsyncIterable<AssistantStreamEvent>;
}

export const ASSISTANT_STREAM_PROVIDER = Symbol('ASSISTANT_STREAM_PROVIDER');
