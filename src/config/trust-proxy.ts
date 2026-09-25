/**
 * Express `trust proxy` hop count, so `req.ip` is the real client address
 * (used by the per-IP login throttle and the audit log).
 *
 * Production sits behind exactly one reverse proxy (Caddy -> api), so it
 * defaults to 1 hop: Express takes the right-most X-Forwarded-For entry, the one
 * Caddy appended, which a client cannot forge. Anywhere else the default is 0 —
 * trust nothing, ignore X-Forwarded-For — because with no proxy in front a
 * client-supplied header would spoof `req.ip`. `TRUST_PROXY_HOPS` (validated in
 * env.validation.ts, 0-10) overrides either default when the topology differs.
 */
export function resolveTrustProxy(env: {
  NODE_ENV?: string;
  TRUST_PROXY_HOPS?: string;
}): number {
  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== '') {
    return Number(env.TRUST_PROXY_HOPS);
  }
  return env.NODE_ENV === 'production' ? 1 : 0;
}
