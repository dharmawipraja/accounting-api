process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL ??=
  'postgresql://accounting:accounting@localhost:5432/accounting?schema=public';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.JWT_ACCESS_TTL = '900s';
process.env.JWT_REFRESH_TTL = '7d';
// Every e2e request comes from loopback (one client IP), so the per-IP login
// ceiling (default 30/min) would turn a spec with many HTTP logins into fake
// 429 "flakiness". Raised for the suite; throttle.e2e-spec.ts pins the real
// default back via ./throttle-default-env (imported first).
process.env.THROTTLE_LOGIN_IP_LIMIT ??= '1000';
