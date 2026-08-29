import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from './auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function proxyApiRequest(
  request: Request,
  path: string,
  method: 'GET' | 'PATCH' | 'POST',
): Promise<Response> {
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...apiAuthorizationHeaders(session),
  };
  for (const name of [
    'content-type',
    'idempotency-key',
    'x-careos-correlation-id',
    'x-careos-home-id',
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const upstream = await fetch(`${API_URL}${path}`, {
    body: method === 'GET' ? undefined : await request.text(),
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
