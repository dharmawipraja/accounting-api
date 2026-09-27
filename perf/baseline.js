import http from 'k6/http';
import { check, sleep } from 'k6';

const ORIGIN = __ENV.BASE_URL || 'http://localhost:3000';
// Every business route lives under the /v1 URI version.
const BASE = `${ORIGIN}/v1`;

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({
      email: __ENV.USER_EMAIL,
      password: __ENV.USER_PASSWORD,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  const token = res.json('accessToken');
  // Resolve two posting accounts for the optional write scenario (cash + capital).
  const accRes = http.get(`${BASE}/ledger/accounts?limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = /** @type {Account[]} */ (accRes.json('data') || []);
  // Cash is a system account, identified by role; Modal is plain seeded equity.
  const cash = accounts.find((a) => a.role === 'CASH');
  const capital = accounts.find((a) => a.code === '3-1000');
  return { token, cashId: cash?.id, capitalId: capital?.id };
}

/**
 * @typedef {{ id: string, code: string, role: string | null }} Account
 * @typedef {{ token: string, cashId?: string, capitalId?: string }} SetupData
 */

/** @param {SetupData} data */
export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };
  // read-heavy hot paths
  http.get(`${BASE}/reports/balance-sheet`, { headers });
  http.get(`${BASE}/reports/income-statement?from=2026-01-01&to=2026-12-31`, {
    headers,
  });
  http.get(`${BASE}/ledger/trial-balance`, { headers });
  http.get(`${BASE}/sales-invoices`, { headers });
  // Opt-in write scenario (set WRITE_SCENARIO=1). Posts a balanced journal entry.
  // NB: writes real data + consumes gapless numbers — run against a throwaway DB,
  // and stay under the 300/min per-user throttle.
  if (__ENV.WRITE_SCENARIO && data.cashId && data.capitalId) {
    const body = JSON.stringify({
      date: '2026-06-15',
      description: 'perf write',
      lines: [
        { accountId: data.cashId, debit: '1.0000', credit: '0.0000' },
        { accountId: data.capitalId, debit: '0.0000', credit: '1.0000' },
      ],
    });
    http.post(`${BASE}/ledger/journal-entries`, body, {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `perf-${__VU}-${__ITER}`,
      },
    });
  }
  sleep(1);
}
