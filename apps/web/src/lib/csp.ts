export function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const scriptSources = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  if (isDevelopment) scriptSources.push(`'unsafe-eval'`);

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://authjs.dev",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    ...(isDevelopment ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
