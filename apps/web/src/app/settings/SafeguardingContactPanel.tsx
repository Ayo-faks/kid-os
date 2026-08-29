'use client';

import { useState, type FormEvent, type JSX } from 'react';

export interface SafeguardingContactView {
  readonly canUpdate: boolean;
  readonly configured: boolean;
  readonly email: string | null;
  readonly name: string | null;
  readonly updatedAt: string;
}

export function SafeguardingContactPanel({
  initialContact,
}: {
  readonly initialContact: SafeguardingContactView;
}): JSX.Element {
  const [contact, setContact] = useState(initialContact);
  const [name, setName] = useState(initialContact.name ?? '');
  const [email, setEmail] = useState(initialContact.email ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if ((trimmedName === '') !== (trimmedEmail === '')) {
      setError('Enter both a contact name and email address, or clear both fields.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/settings/safeguarding-contact', {
        body: JSON.stringify({
          email: trimmedEmail === '' ? null : trimmedEmail,
          name: trimmedName === '' ? null : trimmedName,
        }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': crypto.randomUUID(),
        },
        method: 'PUT',
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isContact(payload)) {
        throw new Error(`Unable to save safeguarding contact (HTTP ${response.status}).`);
      }
      setContact(payload);
      setName(payload.name ?? '');
      setEmail(payload.email ?? '');
      setStatus(
        payload.configured ? 'Safeguarding contact saved.' : 'Safeguarding contact cleared.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save safeguarding contact.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="safeguarding-contact-heading"
      className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold" id="safeguarding-contact-heading">
            Safeguarding contact
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Approved safeguarding incidents can generate a sensitive email draft for this contact.
            CareOS never sends the draft automatically; two-person review still applies.
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-xs font-semibold ring-1 ${
            contact.configured
              ? 'bg-emerald-50 text-emerald-900 ring-emerald-100'
              : 'bg-amber-50 text-amber-900 ring-amber-100'
          }`}
        >
          {contact.configured ? 'Configured' : 'Not configured'}
        </span>
      </div>

      {contact.canUpdate ? (
        <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
          <label className="text-sm font-medium text-slate-700">
            Contact name
            <input
              autoComplete="name"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 px-3"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Contact email
            <input
              autoComplete="email"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 px-3"
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button
              className="min-h-11 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400"
              disabled={saving}
              type="submit"
            >
              {saving ? 'Saving…' : 'Save safeguarding contact'}
            </button>
            {contact.configured ? (
              <button
                className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 disabled:text-slate-400"
                disabled={saving}
                onClick={() => {
                  setName('');
                  setEmail('');
                }}
                type="button"
              >
                Clear fields
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-slate-600">Contact</dt>
            <dd className="mt-1">{contact.name ?? 'Not configured'}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-600">Email</dt>
            <dd className="mt-1 break-all">{contact.email ?? 'Not configured'}</dd>
          </div>
        </dl>
      )}

      {error !== null ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {status !== null ? (
        <output className="mt-3 block text-sm text-emerald-800">{status}</output>
      ) : null}
    </section>
  );
}

function isContact(value: unknown): value is SafeguardingContactView {
  if (typeof value !== 'object' || value === null) return false;
  const contact = value as Partial<SafeguardingContactView>;
  return (
    typeof contact.canUpdate === 'boolean' &&
    typeof contact.configured === 'boolean' &&
    (contact.email === null || typeof contact.email === 'string') &&
    (contact.name === null || typeof contact.name === 'string') &&
    typeof contact.updatedAt === 'string'
  );
}
