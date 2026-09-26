// Imported FIRST by audit-timeout.e2e-spec.ts, before anything loads
// src/config/throttle.config.ts (which reads process.env at module load), so
// the per-request timeout is short enough to trip with a slow stub handler.
process.env.REQUEST_TIMEOUT_MS = '1500';
