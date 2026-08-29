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

  copyHeader(request, headers, 'idempotency-key');
  copyHeader(request, headers, 'x-careos-correlation-id');
  copyHeader(request, headers, 'x-careos-home-id');

  const upstream = await fetch(`${API_URL}/incidents`, {
    body: await request.text(),
    headers,
    method: 'POST',
  });

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    },
    status: upstream.status,
  });
}

function copyHeader(request: Request, headers: Record<string, string>, name: string): void {
  const value = request.headers.get(name);
  if (value !== null) {
    headers[name] = value;
  }
}
