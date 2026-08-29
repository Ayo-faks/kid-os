import { NextResponse } from 'next/server';

import { apiAuthorizationHeaders, getCareosServerSession } from '@/lib/auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';
const GROUPS = new Set(['type', 'home', 'month']);

export async function GET(request: Request): Promise<Response> {
  const session = await getCareosServerSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const incoming = new URL(request.url);
  const groupBy = incoming.searchParams.get('groupBy');
  if (groupBy === null || !GROUPS.has(groupBy)) {
    return NextResponse.json({ error: 'invalid-group-by' }, { status: 400 });
  }
  const query = new URLSearchParams({ groupBy });
  for (const name of ['from', 'to']) {
    const value = incoming.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  const headers: Record<string, string> = {
    accept: 'text/csv',
    ...apiAuthorizationHeaders(session),
  };
  copyHeader(request, headers, 'x-careos-correlation-id');
  copyHeader(request, headers, 'x-careos-home-id');

  const upstream = await fetch(`${API_URL}/reports/incidents/export.csv?${query}`, {
    headers,
    method: 'GET',
  });
  return new Response(upstream.body, {
    headers: {
      'content-disposition':
        upstream.headers.get('content-disposition') ??
        `attachment; filename="incidents-by-${groupBy}.csv"`,
      'content-type': upstream.headers.get('content-type') ?? 'text/csv; charset=utf-8',
    },
    status: upstream.status,
  });
}

function copyHeader(request: Request, headers: Record<string, string>, name: string): void {
  const value = request.headers.get(name);
  if (value !== null) headers[name] = value;
}
