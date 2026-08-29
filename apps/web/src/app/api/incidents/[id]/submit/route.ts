import { proxyApiRequest } from '@/lib/api-proxy';

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyApiRequest(request, `/incidents/${id}/submit`, 'POST');
}
