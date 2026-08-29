'use client';

import { Wand2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { streamSse, type AssistantStreamEvent } from '@/lib/sse';
import { cn } from '@/lib/utils';

interface QuickAction {
  readonly id: 'create_incident' | 'notify_safeguarding' | 'update_behaviour_log';
  readonly label: string;
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'create_incident', label: 'Create incident report' },
  { id: 'notify_safeguarding', label: 'Notify safeguarding lead' },
  { id: 'update_behaviour_log', label: 'Update behaviour log' },
];

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  error?: string;
  retryRequest?: {
    readonly message: string;
    readonly quickActionId?: QuickAction['id'];
  };
}

export function CareAssistantPanel({ homeId }: { readonly homeId?: string }) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [slowAssistantId, setSlowAssistantId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamingRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      behavior: 'smooth',
      top: transcriptRef.current.scrollHeight,
    });
  }, [messages]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (slowTimerRef.current !== null) {
        clearTimeout(slowTimerRef.current);
      }
    },
    [],
  );

  const clearSlowStatus = useCallback(() => {
    if (slowTimerRef.current !== null) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    setSlowAssistantId(null);
  }, []);

  const send = useCallback(
    async (message: string, quickActionId?: QuickAction['id']) => {
      if (streamingRef.current || message.trim().length === 0) {
        return;
      }
      streamingRef.current = true;
      setStreaming(true);

      const userMsg: ChatMessage = {
        content: message,
        id: `u-${Date.now()}`,
        role: 'user',
      };
      const assistantMsg: ChatMessage = {
        content: '',
        id: `a-${Date.now()}`,
        pending: true,
        retryRequest: quickActionId === undefined ? { message } : { message, quickActionId },
        role: 'assistant',
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      clearSlowStatus();
      slowTimerRef.current = setTimeout(() => {
        setSlowAssistantId(assistantMsg.id);
        slowTimerRef.current = null;
      }, 30_000);

      const controller = new AbortController();
      abortRef.current = controller;

      const headers: Record<string, string> = {};
      if (homeId !== undefined) {
        headers['x-careos-home-id'] = homeId;
      }

      try {
        for await (const event of streamSse({
          body: { message, quickActionId },
          headers,
          signal: controller.signal,
          url: '/api/assistant/messages',
        })) {
          clearSlowStatus();
          applyEvent(setMessages, assistantMsg.id, event);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const messageText = error instanceof Error ? error.message : 'stream-failed';
        applyEvent(setMessages, assistantMsg.id, { message: messageText, type: 'error' });
      } finally {
        clearSlowStatus();
        streamingRef.current = false;
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [clearSlowStatus, homeId],
  );

  return (
    <section
      aria-label="Care Assistant"
      className="flex h-full min-h-[420px] flex-col rounded-md bg-slate-950 p-5 text-white shadow-sm"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Care Assistant</h2>
        <Wand2 className="size-4 text-cyan-200" aria-hidden="true" />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            className="flex h-10 items-center justify-between rounded-md bg-white/10 px-3 text-left text-sm font-medium ring-1 ring-white/10 transition hover:bg-white/15 disabled:opacity-50"
            disabled={streaming}
            key={action.id}
            onClick={() => {
              if (input.trim().length === 0) {
                setInput(`[${action.label}] `);
                return;
              }
              void send(input, action.id);
            }}
            type="button"
          >
            {action.label}
            <span aria-hidden="true">+</span>
          </button>
        ))}
      </div>

      <div
        className="mb-3 flex-1 overflow-y-auto rounded-md bg-black/30 p-3 ring-1 ring-white/10"
        ref={transcriptRef}
      >
        {messages.length === 0 ? (
          <p className="text-sm text-slate-300">
            Ask a question or pick a quick-action. Replies stream from Hermes.
          </p>
        ) : (
          <ul className="space-y-3">
            {messages.map((msg) => (
              <li
                className={cn(
                  'rounded-md px-3 py-2 text-sm',
                  msg.role === 'user' ? 'bg-cyan-500/20 text-cyan-50' : 'bg-white/10 text-white',
                )}
                key={msg.id}
              >
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </p>
                {msg.role === 'assistant' && msg.pending === true && msg.content === '' ? (
                  <div aria-atomic="true" aria-live="polite" role="status">
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block motion-safe:animate-pulse"
                    >
                      ...
                    </span>
                    {slowAssistantId === msg.id
                      ? 'Still working — responses can take a few minutes.'
                      : 'Care Assistant is thinking…'}
                  </div>
                ) : (
                  <p
                    aria-live={msg.role === 'assistant' ? 'polite' : undefined}
                    className="whitespace-pre-wrap break-words"
                  >
                    {msg.content}
                    {msg.pending === true ? <span aria-hidden="true">▍</span> : null}
                  </p>
                )}
                {msg.error !== undefined ? (
                  <div
                    aria-live="assertive"
                    className="mt-2 rounded-md bg-rose-950/60 p-3 text-rose-100 ring-1 ring-rose-300/30"
                    role="alert"
                  >
                    <p className="text-xs">{msg.error}</p>
                    {msg.retryRequest !== undefined ? (
                      <button
                        className="mt-2 min-h-10 rounded-md bg-white px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
                        disabled={streaming}
                        onClick={() => {
                          const retryRequest = msg.retryRequest;
                          if (retryRequest === undefined) return;
                          clearMessageError(setMessages, msg.id);
                          void send(retryRequest.message, retryRequest.quickActionId);
                        }}
                        type="button"
                      >
                        Retry response
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <label className="flex-1">
          <span className="sr-only">Message Care Assistant</span>
          <input
            className="h-10 w-full rounded-md bg-white/10 px-3 text-sm text-white placeholder:text-slate-400 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-300"
            disabled={streaming}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Describe what happened…"
            value={input}
          />
        </label>
        <button
          className="h-10 rounded-md bg-cyan-400 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50"
          disabled={streaming || input.trim().length === 0}
          type="submit"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function clearMessageError(
  setMessages: (updater: (prev: readonly ChatMessage[]) => readonly ChatMessage[]) => void,
  assistantId: string,
) {
  setMessages((prev) =>
    prev.map((message) => {
      if (message.id !== assistantId) return message;
      const { error: _error, ...withoutError } = message;
      return withoutError;
    }),
  );
}

function applyEvent(
  setMessages: (updater: (prev: readonly ChatMessage[]) => readonly ChatMessage[]) => void,
  assistantId: string,
  event: AssistantStreamEvent,
) {
  setMessages((prev) =>
    prev.map((msg) => {
      if (msg.id !== assistantId) {
        return msg;
      }
      if (event.type === 'token') {
        return { ...msg, content: msg.content + event.content, pending: true };
      }
      if (event.type === 'done') {
        return { ...msg, pending: false };
      }
      return { ...msg, error: event.message, pending: false };
    }),
  );
}
