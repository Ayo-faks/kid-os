import { createServer, type Server } from 'node:http';

export function startWorkerHealthServer(
  port = positiveInteger(process.env.WORKER_HEALTH_PORT, 8081),
): Server {
  const server = createServer((request, response) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url === '/health') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : 'ok');
      return;
    }

    response.writeHead(404, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('not found');
  });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`[worker] health endpoint listening on port ${port}\n`);
  });
  server.unref();
  return server;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
