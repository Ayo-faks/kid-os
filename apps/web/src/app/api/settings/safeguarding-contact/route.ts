import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from '@/lib/auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function GET(request: Request): Promise<Response> {
  return proxy(request, 'GET');
}

export async function PUT(request: Request): Promise<Response> {
  return proxy(request, 'PUT');
}

async function proxy(request: Request, method: 'GET' | 'PUT'): Promise<Response> {
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const headers: Record<string, string> = { ...apiAuthorizationHeaders(session) };
  if (method === 'PUT') headers['content-type'] = 'application/json';
  for (const name of ['idempotency-key', 'x-careos-correlation-id', 'x-careos-home-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const upstream = await fetch(`${API_URL}/settings/safeguarding-contact`, {
    ...(method === 'PUT' ? { body: await request.text() } : {}),
    cache: 'no-store',
    headers,
    method,
  });
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    },
    status: upstream.status,
  });
}
