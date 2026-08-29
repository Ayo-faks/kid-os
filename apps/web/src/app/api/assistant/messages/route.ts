import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from '@/lib/auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function POST(request: Request): Promise<Response> {
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...apiAuthorizationHeaders(session),
  };

  const homeId = request.headers.get('x-careos-home-id');
  if (homeId !== null) {
    headers['x-careos-home-id'] = homeId;
  }
  const correlationId = request.headers.get('x-careos-correlation-id');
  if (correlationId !== null) {
    headers['x-careos-correlation-id'] = correlationId;
  }

  const upstream = await fetch(`${API_URL}/assistant/messages`, {
    body: await request.text(),
    headers,
    method: 'POST',
    signal: request.signal,
  });

  return new Response(upstream.body, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    },
    status: upstream.status,
  });
}
