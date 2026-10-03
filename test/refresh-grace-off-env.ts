// Imported FIRST by auth-refresh-rotation.e2e-spec.ts, before the app's config
// loads: that spec exercises strict reuse detection (every replay of a consumed
// refresh token revokes the family), so the concurrent-refresh grace is off.
// auth-session-revocation.e2e-spec.ts covers the default grace window.
process.env.REFRESH_REUSE_GRACE_MS = '0';
