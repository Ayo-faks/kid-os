import { proxyApiRequest } from '@/lib/api-proxy';

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyApiRequest(request, `/export-bundles/${id}/download`, 'GET');
}
