'use client';

import { useState, type FormEvent, type JSX } from 'react';

type ChannelKind = 'home' | 'safeguarding' | 'rota' | 'general';

interface ChannelMapping {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly channelId: string;
  readonly channelName: string;
  readonly updatedAt: string;
}

export interface ChannelMappingsView {
  readonly mappings: readonly ChannelMapping[];
}

interface LinkCodeResponse {
  readonly code: string;
  readonly expiresAt: string;
  readonly slashCommand: string;
}

const KINDS: readonly ChannelKind[] = ['home', 'safeguarding', 'rota', 'general'];

export function MattermostPanel({
  initial,
}: {
  readonly initial: ChannelMappingsView;
}): JSX.Element {
  const [mappings, setMappings] = useState<readonly ChannelMapping[]>(initial.mappings);
  const [kind, setKind] = useState<ChannelKind>('home');
  const [channelId, setChannelId] = useState('');
  const [channelName, setChannelName] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);

  const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);
  const [issuingCode, setIssuingCode] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function submitMapping(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSavingMapping(true);
    setMappingError(null);

    try {
      if (channelId.trim().length === 0 || channelName.trim().length === 0) {
        throw new Error('Both the channel ID and a friendly name are required.');
      }

      const response = await fetch('/api/comms/mattermost/channels', {
        body: JSON.stringify({
          channelId: channelId.trim(),
          channelName: channelName.trim(),
          kind,
        }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': crypto.randomUUID(),
        },
        method: 'POST',
      });

      const payload = (await response.json()) as unknown;
      if (!response.ok || !isMapping(payload)) {
        throw new Error('Failed to save the channel mapping.');
      }

      setMappings((prev) => {
        const others = prev.filter((m) => m.kind !== payload.kind);
        return [...others, payload].sort((a, b) => a.kind.localeCompare(b.kind));
      });
      setChannelId('');
      setChannelName('');
    } catch (cause) {
      setMappingError(cause instanceof Error ? cause.message : 'Failed to save mapping.');
    } finally {
      setSavingMapping(false);
    }
  }

  async function issueLinkCode(): Promise<void> {
    setIssuingCode(true);
    setLinkError(null);
    setLinkCode(null);

    try {
      const response = await fetch('/api/comms/mattermost/link-codes', {
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': crypto.randomUUID(),
        },
        method: 'POST',
      });

      const payload = (await response.json()) as unknown;
      if (!response.ok || !isLinkCode(payload)) {
        throw new Error('Failed to issue a /link code.');
      }
      setLinkCode(payload);
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : 'Failed to issue /link code.');
    } finally {
      setIssuingCode(false);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="channels-heading"
        className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <h2 id="channels-heading" className="text-lg font-semibold">
          Channel mappings
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          One channel per kind, per home. Saving overwrites the existing mapping.
        </p>

        <ul className="mt-4 divide-y divide-slate-200" data-testid="channel-mapping-list">
          {mappings.length === 0 ? (
            <li className="py-3 text-sm text-slate-600">No mappings yet.</li>
          ) : (
            mappings.map((mapping) => (
              <li key={mapping.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium capitalize">{mapping.kind}</p>
                  <p className="text-slate-600">
                    {mapping.channelName}{' '}
                    <span className="font-mono text-xs text-slate-500">({mapping.channelId})</span>
                  </p>
                </div>
                <p className="text-xs text-slate-500">
                  Updated {new Date(mapping.updatedAt).toLocaleString()}
                </p>
              </li>
            ))
          )}
        </ul>

        <form
          className="mt-5 grid gap-3 sm:grid-cols-[120px_1fr_1fr_auto]"
          onSubmit={(event) => {
            void submitMapping(event);
          }}
        >
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Kind</span>
            <select
              className="rounded-md border border-slate-300 px-2 py-1.5"
              onChange={(event) => setKind(event.target.value as ChannelKind)}
              value={kind}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Channel ID</span>
            <input
              className="rounded-md border border-slate-300 px-2 py-1.5"
              onChange={(event) => setChannelId(event.target.value)}
              placeholder="abc123…"
              value={channelId}
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Channel name</span>
            <input
              className="rounded-md border border-slate-300 px-2 py-1.5"
              onChange={(event) => setChannelName(event.target.value)}
              placeholder="Town hall"
              value={channelName}
            />
          </label>
          <button
            className="self-end rounded-md bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-cyan-300"
            disabled={savingMapping}
            type="submit"
          >
            {savingMapping ? 'Saving…' : 'Save'}
          </button>
        </form>
        {mappingError !== null ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {mappingError}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="link-code-heading"
        className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <h2 id="link-code-heading" className="text-lg font-semibold">
          Link your Mattermost account
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Generate a one-time code, then run the slash command in any mapped channel to bind this
          CareOS account to your Mattermost user.
        </p>

        <button
          className="mt-4 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          data-testid="issue-link-code"
          disabled={issuingCode}
          onClick={() => {
            void issueLinkCode();
          }}
          type="button"
        >
          {issuingCode ? 'Issuing…' : 'Issue /link code'}
        </button>

        {linkCode !== null ? (
          <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm" data-testid="link-code-result">
            <p>
              Run this in any mapped channel:{' '}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs ring-1 ring-slate-200">
                {linkCode.slashCommand}
              </code>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Expires {new Date(linkCode.expiresAt).toLocaleString()}.
            </p>
          </div>
        ) : null}
        {linkError !== null ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {linkError}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function isMapping(value: unknown): value is ChannelMapping {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ChannelMapping>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.channelId === 'string' &&
    typeof candidate.channelName === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

function isLinkCode(value: unknown): value is LinkCodeResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<LinkCodeResponse>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.slashCommand === 'string'
  );
}
