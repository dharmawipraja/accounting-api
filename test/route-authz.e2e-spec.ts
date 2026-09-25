import { INestApplication, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * AUDIT3-7 route-authz guard: every state-changing (non-GET) route must declare
 * @Roles (handler or controller level) unless it is deliberately open to every
 * authenticated user / public — and then it must be listed here, so adding a
 * new unguarded write is a conscious, reviewed decision.
 */
const ALLOW_WITHOUT_ROLES: RegExp[] = [
  /^auth\//, // login/refresh/logout/logout-all/change-password — self-service
  /^tax\/calculate$/, // read-only calculator (POST for a body)
  /^journal-entries\/preview$/, // read-only JE dry-run (POST for a body)
];

interface RouteInfo {
  route: string;
  method: string;
  hasRoles: boolean;
}

function joinPath(base: unknown, sub: unknown): string {
  const parts = [base, sub]
    .flatMap((p): unknown[] => (Array.isArray(p) ? (p as unknown[]) : [p]))
    .filter((p): p is string => typeof p === 'string' && p !== '' && p !== '/')
    .map((p) => p.replace(/^\/+|\/+$/g, ''));
  return parts.join('/');
}

describe('Route authorization coverage (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let routes: RouteInfo[];

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    routes = [];
    for (const wrapper of discovery.getControllers()) {
      const cls = wrapper.metatype as (new (...a: unknown[]) => object) | null;
      if (!cls) continue;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, cls);
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as (...a: unknown[]) => unknown;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (method === undefined) continue; // not a route handler
        const roles = reflector.getAllAndOverride<unknown[] | undefined>(
          ROLES_KEY,
          [handler, cls],
        );
        routes.push({
          route: joinPath(base, Reflect.getMetadata(PATH_METADATA, handler)),
          method: RequestMethod[method],
          hasRoles: Array.isArray(roles) && roles.length > 0,
        });
      }
    }
  }, 120_000);

  afterAll(() => cleanup());

  it('discovers the application routes', () => {
    // Sanity: the scan actually found the surface (not a vacuous pass).
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.some((r) => r.route === 'auth/login')).toBe(true);
  });

  it('every non-GET route has @Roles or is explicitly allow-listed', () => {
    const unguarded = routes
      .filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
      .filter((r) => !r.hasRoles)
      .filter((r) => !ALLOW_WITHOUT_ROLES.some((re) => re.test(r.route)))
      .map((r) => `${r.method} /${r.route}`);
    expect(unguarded).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    for (const re of ALLOW_WITHOUT_ROLES) {
      expect(routes.some((r) => re.test(r.route))).toBe(true);
    }
  });
});
