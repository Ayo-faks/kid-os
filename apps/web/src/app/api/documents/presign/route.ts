import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from '@/lib/auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function POST(request: Request): Promise<Response> {
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const headers: Record<string, string> = {
    ...apiAuthorizationHeaders(session),
    'content-type': 'application/json',
  };
  for (const name of ['idempotency-key', 'x-careos-correlation-id', 'x-careos-home-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const upstream = await fetch(`${API_URL}/documents/presign`, {
    body: await request.text(),
    cache: 'no-store',
    headers,
    method: 'POST',
    signal: request.signal,
  });

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    },
    status: upstream.status,
  });
}
