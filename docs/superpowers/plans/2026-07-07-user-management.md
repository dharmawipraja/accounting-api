# User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ADMIN-only user management (create with one-time temp password, list, update with safety rails, reset-password, soft-delete) plus self-service change-password and per-request auth freshness, per `docs/superpowers/specs/2026-07-07-user-management-design.md`.

**Architecture:** A new `UserAdminModule` (controller + orchestration service) sits on top of the existing internal `UsersService`; `change-password` lives in AuthModule (which already has both `UsersService` and `RefreshTokenService` — putting refresh-token revocation inside `UsersService` would create a circular module import). `JwtStrategy.validate` becomes async and reads the user row per request, making deactivation/role changes immediate. A `mustChangePassword` flag + global guard forces temp-password rotation.

**Tech Stack:** NestJS 11, Prisma 7 (pg adapter), argon2, class-validator, supertest e2e via `bootstrapTestApp()` (testcontainers).

## Global Constraints

- Work on branch `feat/user-management`; ff-merge to `main` at the end; **never push**.
- TDD every task: write the failing test, watch it fail, implement, watch it pass, commit.
- Unit tests only on PURE code (temp-password generator); everything DB/HTTP-bound is e2e (`npx jest --config test/jest-e2e.json <spec>`).
- All error responses go through existing `DomainError` subclasses (422 `ValidationFailedError`, 409 `ConflictDomainError`, 404 `NotFoundDomainError`) — never raw `HttpException` in services.
- Response DTOs: named `*ResponseDto` classes with `@ApiProperty` on every field; NEVER serialize `passwordHash`, `deletedAt`, `deletedBy`.
- **No `@IdempotentWrite()` on any user endpoint** (deliberate — see spec: unique email dedupes creates; keeps temp passwords out of the idempotency response cache).
- Inside `prisma.client.$transaction(async (tx) => …)` the soft-delete extension does NOT apply — every `tx.user.*` query must filter `deletedAt: null` explicitly.
- Final gate before merge: `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm run test:cov:all` (merged floors 90/86/90/90), `npm run openapi:export`.
- Prettier formatting; scope `prettier --write` to files you touched (never the whole `docs/` tree).

---

### Task 1: Branch, schema migration, shared error type

**Files:**
- Modify: `prisma/schema.prisma` (User model)
- Create: `prisma/migrations/<timestamp>_add_must_change_password/migration.sql` (generated)
- Modify: `src/common/errors/domain-errors.ts`
- Test: `src/common/errors/exception-status.spec.ts` (extend)

**Interfaces:**
- Produces: `User.mustChangePassword: boolean` (Prisma), `PasswordChangeRequiredError` (`code='PASSWORD_CHANGE_REQUIRED'`, `status=403`) used by Tasks 4–7.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/user-management
```

- [ ] **Step 2: Write the failing unit test** — append to the `statusFromException` describe in `src/common/errors/exception-status.spec.ts`:

```ts
it('maps PasswordChangeRequiredError to 403', () => {
  expect(statusFromException(new PasswordChangeRequiredError('change it'))).toBe(403);
});
```

Import `PasswordChangeRequiredError` from `./domain-errors` at the top.

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest exception-status`
Expected: FAIL — `PasswordChangeRequiredError` is not exported (compile error is the expected failure shape for a new symbol).

- [ ] **Step 4: Implement** — in `src/common/errors/domain-errors.ts`, next to `ForbiddenDomainError`:

```ts
/** Thrown while a user's mustChangePassword flag is set — the frontend
 *  redirects to the change-password screen on this code. */
export class PasswordChangeRequiredError extends DomainError {
  readonly code = 'PASSWORD_CHANGE_REQUIRED';
  readonly status = 403;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest exception-status` → PASS.

- [ ] **Step 6: Schema + migration** — in `prisma/schema.prisma` `model User`, after `isActive`:

```prisma
  mustChangePassword Boolean @default(false) @map("must_change_password")
```

```bash
npx dotenv -e .env.development -- prisma migrate dev --name add_must_change_password
npx prisma generate
npx tsc --noEmit -p tsconfig.json
```

Expected: migration applies, typecheck clean. Inspect the generated SQL — it must be exactly one `ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;`. (If `migrate dev` creates it empty, delete its row from `_prisma_migrations` and re-run — known gotcha.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(users): mustChangePassword column + PASSWORD_CHANGE_REQUIRED error"
```

---

### Task 2: Temp-password generator (pure, unit-tested)

**Files:**
- Create: `src/users/temp-password.ts`
- Test: `src/users/temp-password.spec.ts`

**Interfaces:**
- Produces: `generateTempPassword(): string` — 16 chars from an unambiguous charset; consumed by Task 5 (create) and Task 7 (reset).

- [ ] **Step 1: Write the failing test** — `src/users/temp-password.spec.ts`:

```ts
import { generateTempPassword, TEMP_PASSWORD_CHARSET } from './temp-password';

describe('generateTempPassword', () => {
  it('returns 16 chars drawn only from the unambiguous charset', () => {
    const pw = generateTempPassword();
    expect(pw).toHaveLength(16);
    for (const ch of pw) expect(TEMP_PASSWORD_CHARSET).toContain(ch);
  });
  it('excludes ambiguous characters', () => {
    for (const bad of ['0', 'O', '1', 'l', 'I']) {
      expect(TEMP_PASSWORD_CHARSET).not.toContain(bad);
    }
  });
  it('is not deterministic', () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest temp-password` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/users/temp-password.ts`:

```ts
import { randomInt } from 'crypto';

/** No 0/O/1/l/I — temp passwords are read aloud / retyped once. */
export const TEMP_PASSWORD_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

const TEMP_PASSWORD_LENGTH = 16;

/** One-time password for admin create/reset; crypto-random, shown exactly once. */
export function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_CHARSET[randomInt(TEMP_PASSWORD_CHARSET.length)];
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest temp-password` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/users/temp-password.ts src/users/temp-password.spec.ts
git commit -m "feat(users): crypto-random temp-password generator"
```

---

### Task 3: Per-request auth freshness in JwtStrategy

**Files:**
- Modify: `src/auth/strategies/jwt.strategy.ts`
- Modify: `src/common/openapi/openapi.models.ts` (add `mustChangePassword` to `AuthenticatedUserDto`)
- Test: `test/users-management.e2e-spec.ts` (new)

**Interfaces:**
- Consumes: `UsersService.findById(id): Promise<SafeUser | null>` (existing; soft-delete-filtered).
- Produces: `AuthenticatedUser` gains `mustChangePassword: boolean`; `req.user.role` is now the LIVE DB role (Tasks 4–7 rely on both).

- [ ] **Step 1: Write the failing e2e test** — create `test/users-management.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('User management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let adminId: string;
  const server = () => app.getHttpServer() as App;

  const login = async (email: string, password: string) =>
    (await app.get(AuthService).login(email, password)).accessToken;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    const admin = await app.get(UsersService).create({
      email: 'admin@um.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminId = admin.id;
    adminToken = await login('admin@um.test', 'secret123');
  }, 120_000);

  afterAll(() => cleanup());

  describe('per-request freshness', () => {
    it('a deactivated user is rejected on the very next request (401)', async () => {
      const u = await app.get(UsersService).create({
        email: 'fresh@um.test',
        password: 'secret123',
        name: 'F',
        role: 'VIEWER',
      });
      const token = await login('fresh@um.test', 'secret123');
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await prisma.client.user.update({
        where: { id: u.id },
        data: { isActive: false },
      });
      // Same still-valid access token — must now be rejected immediately.
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('a role change takes effect on the next request without re-login', async () => {
      const u = await app.get(UsersService).create({
        email: 'promo@um.test',
        password: 'secret123',
        name: 'P',
        role: 'VIEWER',
      });
      const token = await login('promo@um.test', 'secret123');
      // VIEWER cannot create a partner (ACCOUNTANT+ write) → 403.
      await request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'UM-P1', name: 'X', isCustomer: true })
        .expect(403);
      await prisma.client.user.update({
        where: { id: u.id },
        data: { role: 'ACCOUNTANT' },
      });
      // Same token, live role → allowed now.
      await request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'UM-P1', name: 'X', isCustomer: true })
        .expect(201);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config test/jest-e2e.json users-management`
Expected: both tests FAIL — deactivated token still gets 200, promoted token still gets 403 (JWT is stateless today).

- [ ] **Step 3: Implement** — replace `src/auth/strategies/jwt.strategy.ts` body:

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '../role.enum';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface RefreshJwtPayload {
  sub: string;
  jti: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /** Per-request freshness (deliberate DB read): deactivation, deletion, and
   *  role changes take effect on the NEXT request, not at token expiry.
   *  findById is soft-delete-filtered, so a deleted user resolves to null. */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub) throw new UnauthorizedException();
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      role: user.role as Role,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
```

`AuthModule` already imports `UsersModule` (which exports `UsersService`) — no module change needed.

In `src/common/openapi/openapi.models.ts`, add to `AuthenticatedUserDto`:

```ts
  @ApiProperty() mustChangePassword!: boolean;
```

- [ ] **Step 4: Run to verify it passes, plus regression suites**

Run: `npx jest --config test/jest-e2e.json users-management auth rbac` → all PASS (every authenticated request in the suite now exercises the DB check).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(auth): per-request user freshness — deactivation/role changes bite immediately"
```

---

### Task 4: change-password endpoint + forced-change guard

**Files:**
- Create: `src/auth/decorators/allow-with-pending-password.decorator.ts`
- Create: `src/auth/guards/password-change.guard.ts`
- Create: `src/auth/dto/change-password.dto.ts`
- Modify: `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, `src/app.module.ts`
- Modify: `src/users/users.service.ts` (add `changePassword`)
- Test: `test/users-management.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `PasswordChangeRequiredError` (Task 1), `AuthenticatedUser.mustChangePassword` (Task 3), `RefreshTokenService.revokeAllForUser(userId)` (existing).
- Produces: `POST /v1/auth/change-password` (200 `{ ok: true }`); `@AllowWithPendingPassword()`; `UsersService.changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void>` (throws `UnauthorizedException` on wrong current password, clears `mustChangePassword`). Tasks 5–7 rely on the guard behavior.

- [ ] **Step 1: Write the failing e2e tests** — append inside the top-level describe of `test/users-management.e2e-spec.ts`:

```ts
  describe('forced password change', () => {
    let uid: string;
    let token: string;

    beforeAll(async () => {
      const u = await app.get(UsersService).create({
        email: 'temp@um.test',
        password: 'temp-pass-123',
        name: 'T',
        role: 'ACCOUNTANT',
      });
      uid = u.id;
      await prisma.client.user.update({
        where: { id: uid },
        data: { mustChangePassword: true },
      });
      token = await login('temp@um.test', 'temp-pass-123');
    });

    it('blocks business endpoints with 403 PASSWORD_CHANGE_REQUIRED', async () => {
      const res = await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect((res.body as { code: string }).code).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('still allows /auth/me while pending', async () => {
      const res = await request(server())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    });

    it('rejects a wrong current password (401) and a short new one (400)', async () => {
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'wrong', newPassword: 'long-enough-pw' })
        .expect(401);
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'temp-pass-123', newPassword: 'short' })
        .expect(400);
    });

    it('change-password unblocks the user and revokes refresh tokens', async () => {
      const pair = await app.get(AuthService).login('temp@um.test', 'temp-pass-123');
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'temp-pass-123', newPassword: 'brand-new-pw-9' })
        .expect(200);
      // Unblocked on the next request (flag cleared, fresh read per request).
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Old refresh token is revoked.
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
      // New password works; old one doesn't.
      await request(server())
        .post('/v1/auth/login')
        .send({ email: 'temp@um.test', password: 'temp-pass-123' })
        .expect(401);
      token = await login('temp@um.test', 'brand-new-pw-9');
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config test/jest-e2e.json users-management -t "forced password change"`
Expected: FAIL — no guard (business endpoint returns 200), `POST /v1/auth/change-password` → 404.

- [ ] **Step 3: Implement**

`src/auth/decorators/allow-with-pending-password.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITH_PENDING_PASSWORD = 'allowWithPendingPassword';

/** Handlers a user may call while mustChangePassword is set
 *  (change-password itself, /auth/me, logout). */
export const AllowWithPendingPassword = () =>
  SetMetadata(ALLOW_WITH_PENDING_PASSWORD, true);
```

`src/auth/guards/password-change.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_WITH_PENDING_PASSWORD } from '../decorators/allow-with-pending-password.decorator';
import { AuthenticatedUser } from '../strategies/jwt.strategy';
import { PasswordChangeRequiredError } from '../../common/errors/domain-errors';

/** Global guard (after RolesGuard): a user with mustChangePassword=true may
 *  only hit @AllowWithPendingPassword() handlers. @Public routes never reach
 *  here with a user, so they are unaffected. */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user?.mustChangePassword) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WITH_PENDING_PASSWORD,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowed) return true;
    throw new PasswordChangeRequiredError(
      'Password change required before using the API',
    );
  }
}
```

`src/auth/dto/change-password.dto.ts`:

```ts
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString() @MinLength(1) currentPassword!: string;
  @IsString() @MinLength(8) @MaxLength(128) newPassword!: string;
}
```

In `src/users/users.service.ts` add (after `verifyPasswordOrDecoy`):

```ts
  /** Self-service password change: verifies the current password, re-hashes,
   *  clears mustChangePassword. Caller is responsible for session revocation. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId },
    });
    if (!user || !(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.client.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(newPassword),
        mustChangePassword: false,
      },
    });
  }
```

Add `UnauthorizedException` to the `@nestjs/common` import in that file.

In `src/auth/auth.service.ts` add (inject `UsersService`/`RefreshTokenService` are already constructor deps — reuse them):

```ts
  /** Change own password, then revoke ALL refresh families: other devices die
   *  now; the current access token stays valid ≤15m, after which the user
   *  logs in with the new password. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.users.changePassword(userId, currentPassword, newPassword);
    await this.refreshTokens.revokeAllForUser(userId);
  }
```

(Verified: `auth.service.ts`'s constructor already injects `private readonly users: UsersService` and `private readonly refreshTokens: RefreshTokenService` — the snippet's property names are exact.)

In `src/auth/auth.controller.ts` add, next to `logout-all`:

```ts
  @AllowWithPendingPassword()
  @Post('change-password')
  @HttpCode(200)
  @ApiOkResponse({ type: OkFlagDto })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }
```

Also add `@AllowWithPendingPassword()` to the existing `me`, `logout`, and `logout-all` handlers, and import the decorator + DTO.

In `src/app.module.ts`, register the guard LAST in the guard stack:

```ts
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
```

(after the `RolesGuard` line; import from `./auth/guards/password-change.guard`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest --config test/jest-e2e.json users-management auth` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(auth): self-service change-password + PASSWORD_CHANGE_REQUIRED guard"
```

---

### Task 5: UserAdminModule — create (temp password), list, get

**Files:**
- Create: `src/users/dto/create-user.dto.ts`, `src/users/dto/list-users-query.dto.ts`, `src/users/dto/user-response.dto.ts`
- Create: `src/users/user-admin.service.ts`, `src/users/user-admin.controller.ts`, `src/users/user-admin.module.ts`
- Modify: `src/app.module.ts` (import `UserAdminModule`), `src/users/users.service.ts` (create gains `mustChangePassword` passthrough)
- Test: `test/users-management.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `generateTempPassword()` (Task 2), `UsersService.create` (existing), `listPaginated` (`src/common/pagination/paginated.ts`), `PaginationQueryDto`.
- Produces: `POST /v1/users` → 201 `{ user: UserResponseDto, tempPassword }`; `GET /v1/users` → `{data,total,limit,offset}`; `GET /v1/users/:id`; `toUserResponse(u: SafeUser): UserResponseDto`. Tasks 6–7 add to the same controller/service.

- [ ] **Step 1: Write the failing e2e tests** — append:

```ts
  describe('ADMIN user management', () => {
    it('non-ADMIN gets 403 on /v1/users', async () => {
      const t = await (async () => {
        await app.get(UsersService).create({
          email: 'acct@um.test',
          password: 'secret123',
          name: 'A',
          role: 'ACCOUNTANT',
        });
        return login('acct@um.test', 'secret123');
      })();
      await request(server())
        .get('/v1/users')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
    });

    it('creates a user, returns the temp password once, and forces change on first login', async () => {
      const res = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'new@um.test', name: 'New', role: 'APPROVER' })
        .expect(201);
      const body = res.body as {
        user: { id: string; email: string; role: string; mustChangePassword: boolean };
        tempPassword: string;
      };
      expect(body.user.email).toBe('new@um.test');
      expect(body.user.mustChangePassword).toBe(true);
      expect(body.tempPassword).toHaveLength(16);
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      // Temp password logs in but is immediately gated.
      const t = await login('new@um.test', body.tempPassword);
      const gated = await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      expect((gated.body as { code: string }).code).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('duplicate email → 409; lists come enveloped with filters', async () => {
      await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'new@um.test', name: 'Dup', role: 'VIEWER' })
        .expect(409);
      const list = await request(server())
        .get('/v1/users?role=APPROVER&isActive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = list.body as { data: { role: string }[]; total: number; limit: number; offset: number };
      expect(body.limit).toBe(50);
      expect(body.data.every((u) => u.role === 'APPROVER')).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('gets one user by id; 404 for unknown', async () => {
      await request(server())
        .get(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(server())
        .get('/v1/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --config test/jest-e2e.json users-management -t "ADMIN user management"` → FAIL (404 on /v1/users).

- [ ] **Step 3: Implement**

`src/users/dto/create-user.dto.ts`:

```ts
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '../../auth/role.enum';

export class CreateUserDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN']) role!: Role;
}
```

`src/users/dto/list-users-query.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Role } from '../../auth/role.enum';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'])
  role?: Role;

  @IsOptional()
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';
}
```

`src/users/dto/user-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'] })
  role!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() mustChangePassword!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class CreateUserResponseDto {
  @ApiProperty({ type: UserResponseDto }) user!: UserResponseDto;
  @ApiProperty({
    description: 'Shown exactly once — the user must change it on first login.',
  })
  tempPassword!: string;
}

export class PaginatedUsersResponseDto {
  @ApiProperty({ type: [UserResponseDto] }) data!: UserResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
```

(Verified: `User` has `createdAt DateTime @default(now())` — the field is real.)

In `src/users/users.service.ts`, extend `CreateUserInput` and `create` to pass through the flag:

```ts
export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role: Role;
  mustChangePassword?: boolean;
}
```

and in `create`'s `data`: `mustChangePassword: input.mustChangePassword ?? false,`.

`src/users/user-admin.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundDomainError } from '../common/errors/domain-errors';
import { listPaginated } from '../common/pagination/paginated';
import { UsersService, SafeUser } from './users.service';
import { generateTempPassword } from './temp-password';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserResponseDto } from './dto/user-response.dto';

export function toUserResponse(u: SafeUser): UserResponseDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
  };
}

@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  /** Create with a generated one-time password; the caller (controller)
   *  returns it exactly once. Duplicate email → 409 via UsersService. */
  async createWithTempPassword(dto: CreateUserDto) {
    const tempPassword = generateTempPassword();
    const user = await this.users.create({
      email: dto.email,
      password: tempPassword,
      name: dto.name,
      role: dto.role,
      mustChangePassword: true,
    });
    return { user: toUserResponse(user), tempPassword };
  }

  async list(q: ListUsersQueryDto) {
    const where = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.isActive !== undefined ? { isActive: q.isActive === 'true' } : {}),
    };
    // No `search`/`hydrate` (no ?q= on users — small bounded set): the seam
    // takes the non-search `page` branch, exactly like accounts/tax-codes.
    return listPaginated({
      limit: q.limit,
      offset: q.offset,
      present: toUserResponse,
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.user.findMany({
            where,
            orderBy: { email: 'asc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.user.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }

  async getById(id: string): Promise<UserResponseDto> {
    const u = await this.users.findById(id);
    if (!u) throw new NotFoundDomainError('User not found', { id });
    return toUserResponse(u);
  }
}
```

(`toUserResponse` accepts `SafeUser`; the full `User` rows from `findMany` are structurally assignable — the mapper only reads safe fields.)

`src/users/user-admin.controller.ts`:

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { UserAdminService } from './user-admin.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import {
  CreateUserResponseDto,
  PaginatedUsersResponseDto,
  UserResponseDto,
} from './dto/user-response.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('users')
export class UserAdminController {
  constructor(private readonly admin: UserAdminService) {}

  @Post()
  @ApiCreatedResponse({ type: CreateUserResponseDto })
  create(@Body() dto: CreateUserDto): Promise<CreateUserResponseDto> {
    return this.admin.createWithTempPassword(dto);
  }

  @Get()
  @ApiOkResponse({ type: PaginatedUsersResponseDto })
  list(@Query() q: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    return this.admin.list(q);
  }

  @Get(':id')
  @ApiOkResponse({ type: UserResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.admin.getById(id);
  }
}
```

`src/users/user-admin.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { UsersModule } from './users.module';
import { AuthModule } from '../auth/auth.module';
import { UserAdminService } from './user-admin.service';
import { UserAdminController } from './user-admin.controller';

/** Separate from UsersModule so refresh-token revocation (AuthModule) can be
 *  consumed without a UsersModule↔AuthModule cycle. */
@Module({
  imports: [UsersModule, AuthModule],
  providers: [UserAdminService],
  controllers: [UserAdminController],
})
export class UserAdminModule {}
```

In `src/auth/auth.module.ts`, change `exports: [AuthService]` to `exports: [AuthService, RefreshTokenService]` (verified currently missing; consumed by Tasks 6–7).

Register `UserAdminModule` in `src/app.module.ts` imports after `AuthModule`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest --config test/jest-e2e.json users-management` → PASS. Also `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(users): ADMIN create-with-temp-password, list, get endpoints"
```

---

### Task 6: PATCH /v1/users/:id — safety rails + advisory lock + revocation

**Files:**
- Create: `src/users/dto/update-user.dto.ts`
- Modify: `src/users/user-admin.service.ts`, `src/users/user-admin.controller.ts`
- Test: `test/users-management.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `RefreshTokenService.revokeAllForUser(userId)` (via AuthModule export), `ValidationFailedError`.
- Produces: `PATCH /v1/users/:id` → 200 `UserResponseDto`; `USER_ADMIN_LOCK_KEY` constant reused by Task 7's delete.

- [ ] **Step 1: Write the failing e2e tests** — append inside `describe('ADMIN user management')`:

```ts
    it('PATCH updates name/role/isActive; role change revokes refresh tokens', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'patch@um.test', name: 'P', role: 'VIEWER' })
        .expect(201);
      const { user, tempPassword } = created.body as {
        user: { id: string };
        tempPassword: string;
      };
      const pair = await app.get(AuthService).login('patch@um.test', tempPassword);
      const res = await request(server())
        .patch(`/v1/users/${user.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'ACCOUNTANT', name: 'Patched' })
        .expect(200);
      expect((res.body as { role: string; name: string }).role).toBe('ACCOUNTANT');
      // Refresh family revoked by the role change:
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
    });

    it('self-guards: cannot change own role or deactivate self (422)', async () => {
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'VIEWER' })
        .expect(422);
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(422);
      // Changing own NAME is allowed.
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Root Admin' })
        .expect(200);
    });

    it('last-admin guard: an update that would leave zero active ADMINs is refused', async () => {
      // The HTTP self-guard fires before the last-admin count when an admin
      // targets themselves, so exercise the last-admin branch at the service
      // layer with a DIFFERENT actor id (roles are enforced at HTTP, not in
      // the service — this is the exact code path a second admin would hit).
      const { UserAdminService } = await import('../src/users/user-admin.service');
      const svc = app.get(UserAdminService);
      const other = await app.get(UsersService).create({
        email: 'actor@um.test',
        password: 'secret123',
        name: 'Actor',
        role: 'ADMIN',
      });
      // Demote the extra admin back down so exactly one active ADMIN remains…
      await svc.update(adminId, other.id, { role: 'VIEWER' as never });
      // …then any non-self attempt to demote or deactivate the last one → 422.
      await expect(
        svc.update(other.id, adminId, { role: 'VIEWER' as never }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        svc.update(other.id, adminId, { isActive: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
```

- [ ] **Step 2: Run to verify it fails** — `npx jest --config test/jest-e2e.json users-management -t "PATCH"` → FAIL (404, no route).

- [ ] **Step 3: Implement**

`src/users/dto/update-user.dto.ts`:

```ts
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '../../auth/role.enum';

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN']) role?: Role;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```

In `src/users/user-admin.service.ts` add (inject `RefreshTokenService` in the constructor; import `ValidationFailedError`, `Role`):

```ts
/** Advisory-lock key serializing admin-pool mutations (role/isActive/delete).
 *  Far outside the fiscal-year key space used by year-end close (~2000-2200). */
export const USER_ADMIN_LOCK_KEY = 71_001_001;

  async update(actorId: string, id: string, dto: UpdateUserDto) {
    if (id === actorId && dto.role !== undefined)
      throw new ValidationFailedError('You cannot change your own role', { id });
    if (id === actorId && dto.isActive === false)
      throw new ValidationFailedError('You cannot deactivate yourself', { id });

    const leavesAdminPool = (u: { role: string; isActive: boolean }) =>
      u.role === 'ADMIN' &&
      u.isActive &&
      ((dto.role !== undefined && dto.role !== 'ADMIN') || dto.isActive === false);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      // Soft-delete extension does NOT apply inside $transaction → filter explicitly.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
      const target = await tx.user.findFirst({ where: { id, deletedAt: null } });
      if (!target) throw new NotFoundDomainError('User not found', { id });
      if (leavesAdminPool(target)) {
        const otherAdmins = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, deletedAt: null, id: { not: id } },
        });
        if (otherAdmins === 0)
          throw new ValidationFailedError(
            'Cannot remove the last active ADMIN',
            { id },
          );
      }
      return tx.user.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    });

    // Role change or deactivation: kill refresh families (access dies within
    // one request anyway thanks to per-request freshness).
    if (dto.role !== undefined || dto.isActive !== undefined) {
      await this.refreshTokens.revokeAllForUser(id);
    }
    return toUserResponse(updated);
  }
```

Controller addition:

```ts
  @Patch(':id')
  @ApiOkResponse({ type: UserResponseDto })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.admin.update(actor.id, id, dto);
  }
```

(imports: `Patch`, `CurrentUser`, `AuthenticatedUser`, `UpdateUserDto`.)

- [ ] **Step 4: Run to verify it passes** — `npx jest --config test/jest-e2e.json users-management` → PASS; `npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(users): PATCH with self/last-admin rails under advisory lock"
```

---

### Task 7: reset-password + DELETE

**Files:**
- Modify: `src/users/user-admin.service.ts`, `src/users/user-admin.controller.ts`
- Test: `test/users-management.e2e-spec.ts` (extend)

**Interfaces:**
- Consumes: `generateTempPassword`, `UsersService.softDelete(id, deletedBy)`, `RefreshTokenService.revokeAllForUser`, `USER_ADMIN_LOCK_KEY`.
- Produces: `POST /v1/users/:id/reset-password` → 200 `{ user, tempPassword }` (`CreateUserResponseDto` shape); `DELETE /v1/users/:id` → 204.

- [ ] **Step 1: Write the failing e2e tests** — append:

```ts
    it('reset-password returns a new temp password, forces change, revokes sessions', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'reset@um.test', name: 'R', role: 'VIEWER' })
        .expect(201);
      const id = (created.body as { user: { id: string } }).user.id;
      const oldTemp = (created.body as { tempPassword: string }).tempPassword;
      const pair = await app.get(AuthService).login('reset@um.test', oldTemp);

      const reset = await request(server())
        .post(`/v1/users/${id}/reset-password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const newTemp = (reset.body as { tempPassword: string }).tempPassword;
      expect(newTemp).toHaveLength(16);
      expect(newTemp).not.toBe(oldTemp);
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401); // sessions revoked
      await request(server())
        .post('/v1/auth/login')
        .send({ email: 'reset@um.test', password: oldTemp })
        .expect(401); // old password dead
      await app.get(AuthService).login('reset@um.test', newTemp); // new one works
    });

    it('DELETE soft-deletes (404 afterwards, email reusable), self/last-admin refused', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'del@um.test', name: 'D', role: 'VIEWER' })
        .expect(201);
      const id = (created.body as { user: { id: string } }).user.id;
      await request(server())
        .delete(`/v1/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
      await request(server())
        .get(`/v1/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      // Email reusable after tombstone:
      await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'del@um.test', name: 'D2', role: 'VIEWER' })
        .expect(201);
      // Self-delete refused:
      await request(server())
        .delete(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
    });
```

- [ ] **Step 2: Run to verify it fails** — `npx jest --config test/jest-e2e.json users-management -t "reset-password|DELETE"` → FAIL (404 routes).

- [ ] **Step 3: Implement** — service additions:

```ts
  /** New one-time password; all sessions die; user must change on next login. */
  async resetPassword(id: string) {
    const target = await this.users.findById(id);
    if (!target) throw new NotFoundDomainError('User not found', { id });
    const tempPassword = generateTempPassword();
    await this.prisma.client.user.update({
      where: { id },
      data: {
        passwordHash: await argon2.hash(tempPassword),
        mustChangePassword: true,
      },
    });
    await this.refreshTokens.revokeAllForUser(id);
    const updated = await this.users.findById(id);
    return { user: toUserResponse(updated!), tempPassword };
  }

  /** Soft-delete via tombstone; email becomes reusable. Same rails as update. */
  async remove(actorId: string, id: string): Promise<void> {
    if (id === actorId)
      throw new ValidationFailedError('You cannot delete yourself', { id });
    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
      const target = await tx.user.findFirst({ where: { id, deletedAt: null } });
      if (!target) throw new NotFoundDomainError('User not found', { id });
      if (target.role === 'ADMIN' && target.isActive) {
        const otherAdmins = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, deletedAt: null, id: { not: id } },
        });
        if (otherAdmins === 0)
          throw new ValidationFailedError('Cannot remove the last active ADMIN', { id });
      }
    });
    await this.users.softDelete(id, actorId);
    await this.refreshTokens.revokeAllForUser(id);
  }
```

(`import * as argon2 from 'argon2';` in user-admin.service.ts. Note: the tombstone runs after the lock-guarded check in a separate call — acceptable because `softDelete` re-reads and 404s if the row vanished; the advisory lock only needs to make the *last-admin count* race-free, and any interleaved admin-pool mutation also takes the lock.)

Controller additions:

```ts
  @Post(':id/reset-password')
  @HttpCode(200)
  @ApiOkResponse({ type: CreateUserResponseDto })
  resetPassword(@Param('id', ParseUUIDPipe) id: string): Promise<CreateUserResponseDto> {
    return this.admin.resetPassword(id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.admin.remove(actor.id, id);
  }
```

(imports: `Delete`, `HttpCode`.)

- [ ] **Step 4: Run to verify it passes** — full spec + neighbors:

`npx jest --config test/jest-e2e.json users-management users.e2e auth rbac idempotency` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(users): reset-password and soft-delete endpoints"
```

---

### Task 8: Docs, OpenAPI export, spec amendment

**Files:**
- Modify: `docs/api/frontend-guide.md`, `docs/api/frontend-agent-brief.md`, `docs/runbooks/local-development.md`, `docs/runbooks/operator-activation.md`, `docs/superpowers/specs/2026-07-07-user-management-design.md`, `docs/api/openapi.json` (generated)

- [ ] **Step 1: Spec amendment** — in the design doc's change-password section, replace "revokes the user's **other** refresh families (current session continues)" with: "revokes **all** the user's refresh families (the current access token stays valid ≤15 min; other devices die immediately). Revoking only *other* families is impossible here — change-password carries the access token, which has no refresh-family identity."

- [ ] **Step 2: frontend-guide.md** — add a "Users (ADMIN)" endpoint-catalog section listing the five `/v1/users` endpoints + `POST /v1/auth/change-password`, the role matrix row (all `/v1/users/*` = ADMIN), the response-schema quick-map rows (`UserResponseDto`, `CreateUserResponseDto`, `PaginatedUsersResponseDto`), and a "Forced password change" convention block: on any `403 PASSWORD_CHANGE_REQUIRED`, redirect to a change-password screen (`currentPassword` = the temp password); the temp password appears exactly once in the create/reset response; `GET /auth/me` now includes `mustChangePassword`. Note deactivation/role changes take effect on the user's next request.

- [ ] **Step 3: frontend-agent-brief.md** — add rule 14: handle `403 PASSWORD_CHANGE_REQUIRED` globally (redirect to change-password); show `tempPassword` once with a copy button and never store it; `/v1/users/*` is ADMIN-only.

- [ ] **Step 4: Runbooks** — `local-development.md`: note `create-admin` is bootstrap-only now (day-to-day user admin via `POST /v1/users`); `operator-activation.md`: no change needed unless it references user creation — check and align.

- [ ] **Step 5: Export + verify**

```bash
npm run openapi:export
npx jest --config test/jest-e2e.json openapi 2>/dev/null || npx jest openapi
```

Expected: export writes `docs/api/openapi.json` (raw output — do NOT prettier it); the response-schema guard test passes (every 2xx body a named DTO).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs(users): FE guides, runbooks, openapi for user management"
```

---

### Task 9: Final gate + merge

- [ ] **Step 1: Lint + typecheck + prettier check**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npx prettier --check src test
```

- [ ] **Step 2: Full merged coverage gate**

```bash
npm run test:cov:all
```

Expected: unit + e2e suites pass; merged coverage ≥ 90/86/90/90. (If an unrelated suite fails with testcontainer `ECONNREFUSED`, re-run that suite in isolation — known environmental flake.)

- [ ] **Step 3: ff-merge to main (NO push)**

```bash
git checkout main && git merge --ff-only feat/user-management && git branch -d feat/user-management
```

- [ ] **Step 4: Update project memory** — new topic file `user-management.md` (endpoints, per-request freshness gotcha: JwtStrategy now reads DB every request; `USER_ADMIN_LOCK_KEY`; no-idempotency rationale; tx queries need explicit `deletedAt: null`) + one-line MEMORY.md index entry.
