import { proxyApiRequest } from '@/lib/api-proxy';

export async function POST(request: Request): Promise<Response> {
  return proxyApiRequest(request, '/export-bundles', 'POST');
}
