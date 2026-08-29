import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const caddyfile = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../infra/caddy/Caddyfile'),
  'utf8',
);
const matcher = caddyfile.slice(
  caddyfile.indexOf('@web_bff'),
  caddyfile.indexOf('handle @web_bff'),
);

describe('Caddy authenticated BFF routing', () => {
  it.each(['/api/documents*', '/api/reports*', '/api/settings/*'])(
    'routes %s through the cookie-authenticated web BFF matcher',
    (prefix) => {
      expect(matcher).toContain(prefix);
      expect(matcher).toContain('header Cookie *next-auth.session-token*');
    },
  );
});
