/** True for a versioned API path (`/v1`, `/v1/...`, `/v1?...`) — every
 *  business and auth route. The operational probes (/health, /ready,
 *  /metrics) and Swagger (/docs) are left alone. Pure. */
export function isApiPath(url: string): boolean {
  return /^\/v\d+(?:[/?#]|$)/.test(url);
}

/** Express-style middleware (registered for every route in AppModule, so it
 *  runs before guards — a 401 / 403 / 429 / 400 carries it too): every API
 *  response is `Cache-Control: no-store`. Responses are per-user financial
 *  data; no browser, proxy or CDN may keep a copy (a shared machine's back
 *  button / disk cache, a misconfigured cache in front of Caddy). The app
 *  also disables Express ETags (main.ts / the e2e bootstrap) so a
 *  conditional GET can never 304 an authenticated body. */
export function noStoreApiResponses(
  req: { originalUrl?: string; url: string },
  res: { setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  if (isApiPath(req.originalUrl ?? req.url)) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
