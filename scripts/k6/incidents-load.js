// Phase 4 §4 — Incident draft load test.
//
// Target SLO: p95 latency < 2s and error rate < 0.1% (per docs/plan.md
// "99.9% SLO"). Default profile holds 50 RPS of POST /incidents draft
// creates for 10 minutes against a local compose stack. Override the host
// with `BASE_URL` and the auth token with `K6_TOKEN`.
//
// Run via:
//   k6 run -e BASE_URL=http://localhost:8080 -e K6_TOKEN=$JWT \
//     scripts/k6/incidents-load.js
//
// CI is expected to run a smoke variant (1 VU, 30 iterations) so the script
// also accepts `K6_PROFILE=smoke`.

import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TOKEN = __ENV.K6_TOKEN || '';
const TOKEN_URL = __ENV.K6_TOKEN_URL || '';
const CLIENT_ID = __ENV.K6_CLIENT_ID || 'careos-load-test';
const CLIENT_SECRET = __ENV.K6_CLIENT_SECRET || '';
const TENANT_ID = __ENV.K6_TENANT_ID || '11111111-1111-4111-8111-111111111111';
const HOME_ID = __ENV.K6_HOME_ID || '22222222-2222-4222-8222-222222222222';
const RESIDENT_ID = __ENV.K6_RESIDENT_ID || '40000000-0000-4000-8000-000000000001';
const TOKEN_REFRESH_SKEW_MILLISECONDS = 30_000;

const SMOKE = __ENV.K6_PROFILE === 'smoke';

let vuAccessToken = '';
let vuAccessTokenExpiresAt = 0;

export const options = SMOKE
  ? {
      iterations: 30,
      thresholds: {
        http_req_duration: ['p(95)<2000'],
        http_req_failed: ['rate<0.01'],
      },
      vus: 1,
    }
  : {
      scenarios: {
        steady: {
          duration: '10m',
          executor: 'constant-arrival-rate',
          preAllocatedVUs: 50,
          rate: 50,
          timeUnit: '1s',
        },
      },
      summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
      thresholds: {
        // 99.9% SLO → p99 must clear under 3s, p95 under 2s, error rate < 0.1%.
        http_req_duration: ['p(95)<2000', 'p(99)<3000'],
        http_req_failed: ['rate<0.001'],
      },
    };

export function setup() {
  if (TOKEN !== '') return { token: TOKEN };
  return requestAccessToken();
}

function requestAccessToken() {
  if (TOKEN_URL === '' || CLIENT_SECRET === '') {
    fail('K6_TOKEN or K6_TOKEN_URL + K6_CLIENT_SECRET is required');
  }
  const response = http.post(TOKEN_URL, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  if (response.status !== 200) {
    fail(`Keycloak token request failed with ${response.status}`);
  }
  const token = response.json('access_token');
  if (typeof token !== 'string' || token === '') fail('Keycloak response omitted access_token');
  const expiresInSeconds = response.json('expires_in');
  if (
    typeof expiresInSeconds !== 'number' ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    fail('Keycloak response omitted a valid expires_in');
  }
  return { expiresAt: Date.now() + expiresInSeconds * 1_000, token };
}

function accessTokenForIteration(initialToken) {
  if (TOKEN !== '') return initialToken.token;
  if (vuAccessToken === '') {
    vuAccessToken = initialToken.token;
    vuAccessTokenExpiresAt = initialToken.expiresAt;
  }
  if (Date.now() >= vuAccessTokenExpiresAt - TOKEN_REFRESH_SKEW_MILLISECONDS) {
    const refreshedToken = requestAccessToken();
    vuAccessToken = refreshedToken.token;
    vuAccessTokenExpiresAt = refreshedToken.expiresAt;
  }
  return vuAccessToken;
}

export default function main(data) {
  const url = `${BASE_URL}/api/incidents`;
  const payload = JSON.stringify({
    formTemplate: {
      templateId: 'incident.behavioural',
      version: 'v1',
    },
    initialFormData: {},
    residentId: RESIDENT_ID,
  });
  const headers = {
    Authorization: `Bearer ${accessTokenForIteration(data)}`,
    'content-type': 'application/json',
    'idempotency-key': `${__VU}-${__ITER}-${Date.now()}`,
    'x-careos-correlation-id': `k6-${__VU}-${__ITER}`,
    'x-careos-home-id': HOME_ID,
    'x-careos-tenant-id': TENANT_ID,
  };

  const res = http.post(url, payload, { headers });
  check(res, {
    'status is 202 or 200': (r) => r.status === 200 || r.status === 202,
  });
  sleep(0.1);
}
