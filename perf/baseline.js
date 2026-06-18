import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

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
  const accRes = http.get(`${BASE}/ledger/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = (accRes.json('data') || accRes.json() || []);
  const find = (code) => (accounts.find((a) => a.code === code) || {}).id;
  return { token, cashId: find('1-1000'), capitalId: find('3-1000') };
}

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
