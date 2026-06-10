process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL ??=
  'postgresql://accounting:accounting@localhost:5432/accounting?schema=public';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.JWT_ACCESS_TTL = '900s';
process.env.JWT_REFRESH_TTL = '7d';
