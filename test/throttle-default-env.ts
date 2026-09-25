// Imported FIRST by throttle.e2e-spec.ts, before anything loads
// src/config/throttle.config.ts (which reads process.env at module load), so
// that spec exercises the production default per-IP login ceiling instead of
// the raised suite-wide value from setup-env.ts.
process.env.THROTTLE_LOGIN_IP_LIMIT = '30';
