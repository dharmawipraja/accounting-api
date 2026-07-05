describe('throttle.config', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
    jest.resetModules();
  });

  it('uses the defaults when the env overrides are unset', async () => {
    delete process.env.THROTTLE_LIMIT;
    delete process.env.THROTTLE_LOGIN_LIMIT;
    delete process.env.THROTTLE_REFRESH_LIMIT;
    delete process.env.REQUEST_TIMEOUT_MS;
    jest.resetModules();
    const m = await import('./throttle.config');
    expect(m.THROTTLE).toEqual({ global: 300, login: 10, refresh: 30 });
    // Sits above the 30s DB statement timeout so the DB — which genuinely
    // aborts the work — times out before the HTTP layer stops watching.
    expect(m.REQUEST_TIMEOUT_MS).toBe(35_000);
    expect(m.THROTTLE_TTL_MS).toBe(60_000);
  });

  it('reads the overrides from the env when set', async () => {
    process.env.THROTTLE_LIMIT = '500';
    process.env.THROTTLE_LOGIN_LIMIT = '5';
    process.env.THROTTLE_REFRESH_LIMIT = '15';
    process.env.REQUEST_TIMEOUT_MS = '5000';
    jest.resetModules();
    const m = await import('./throttle.config');
    expect(m.THROTTLE).toEqual({ global: 500, login: 5, refresh: 15 });
    expect(m.REQUEST_TIMEOUT_MS).toBe(5000);
  });
});
