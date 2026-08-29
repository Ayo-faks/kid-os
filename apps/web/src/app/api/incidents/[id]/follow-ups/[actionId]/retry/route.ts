import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from '@/lib/auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function POST(
  request: Request,
  {
    params,
  }: {
    readonly params: Promise<{ readonly actionId: string; readonly id: string }>;
  },
): Promise<Response> {
  const { actionId, id } = await params;
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...apiAuthorizationHeaders(session),
  };
  for (const name of ['idempotency-key', 'x-careos-correlation-id', 'x-careos-home-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const upstream = await fetch(
    `${API_URL}/incidents/${encodeURIComponent(id)}/follow-ups/${encodeURIComponent(actionId)}/retry`,
    { body: '{}', headers, method: 'POST' },
  );
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    },
    status: upstream.status,
  });
}
