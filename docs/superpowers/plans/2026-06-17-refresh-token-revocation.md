# SEC-1 Refresh-Token Revocation/Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make refresh tokens stateful and revocable — a `RefreshToken` table with rotation-on-use, reuse (theft) detection, and logout/logout-all — closing audit SEC-1.

**Architecture:** The refresh token stays a JWT carrying a random `jti` (signed with `JWT_REFRESH_SECRET`); the `jti` is the id of a `RefreshToken` row tracking `status` (ACTIVE/CONSUMED/REVOKED) and `familyId` (one login = one session family). A new `RefreshTokenService` owns all row access (issue/rotate/revoke/purge); `AuthService` orchestrates. The access token stays a short-lived stateless JWT.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`) + Postgres (hand-authored migrations), `@nestjs/jwt`, `ms` (TTL parsing — already in the tree), `@nestjs/schedule` (cleanup cron — already wired in AppModule from SEC-2), Jest unit specs (`*.spec.ts` under `src/`), Jest e2e (`test/*.e2e-spec.ts`) against real Postgres via testcontainers.

## Global Constraints

- Node `>=22 <23`. No new runtime deps except promoting `ms` to a direct dependency if it is not already one (it is already resolvable — `src/auth/auth.service.ts` imports its type).
- Domain errors map via `AllExceptionsFilter`: `UnauthorizedDomainError` → 401. RBAC (`RolesGuard`) → 403. The login/refresh error message stays the constant `"Invalid refresh token"` / `"Invalid credentials"` (no enumeration).
- API base path `/v1`; e2e HTTP calls use `/v1/...`. Token-pair response shape stays `{ accessToken, refreshToken }`.
- Refresh token is a JWT `{ sub, jti }` signed with `JWT_REFRESH_SECRET`, `expiresIn = JWT_REFRESH_TTL` (unchanged, 7d). Access token JWT `{ sub, email, role }` unchanged.
- All Prisma model access goes through `this.prisma.client.<model>` (`RefreshToken` is NOT a soft-delete model, so normal `create`/`update`/`updateMany`/`deleteMany`/`$transaction` apply). Rotation + family-revocation are atomic in one `this.prisma.client.$transaction`.
- Migrations are hand-authored SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`, mirroring existing migrations; `npx prisma generate` regenerates the client; the e2e testcontainer applies migrations on boot.
- Unit tests: `npm test -- <pattern>`. E2E: `npm run test:e2e -- <pattern>`. After each task: `npm run typecheck` and `npx eslint <changed files> --max-warnings 0` pass.
- Commit messages are conventional and end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `fix/refresh-token-revocation` (already created, spec at `3873795`).

## File Structure

- `prisma/schema.prisma` — add `RefreshToken` model, `RefreshTokenStatus` enum, `User.refreshTokens` relation (Task 1).
- `prisma/migrations/20260617000000_add_refresh_tokens/migration.sql` — new hand-authored migration (Task 1).
- `src/auth/refresh-token.service.ts` — NEW; the row lifecycle (`issue`/`rotate`/`revokeFamilyByJti`/`revokeAllForUser`/`purgeExpired`) (Task 1; methods extended in 2–4).
- `src/auth/auth.service.ts` — login persists a family; refresh rotates; add `logout`/`logoutAll` (Tasks 1–3).
- `src/auth/strategies/jwt.strategy.ts` — add `RefreshJwtPayload { sub; jti }` type (Task 1).
- `src/auth/auth.controller.ts` — add `logout` (Public) + `logout-all` (authed) routes (Tasks 2–3).
- `src/auth/dto/logout.dto.ts` — NEW; `{ refreshToken }` (Task 2).
- `src/auth/refresh-token-purge.service.ts` — NEW; `@Cron` calling `purgeExpired` (Task 4).
- `src/auth/auth.module.ts` — register `RefreshTokenService` (Task 1) + `RefreshTokenPurgeService` (Task 4).
- `test/auth-refresh-rotation.e2e-spec.ts` — NEW; rotation/reuse/logout/cleanup e2e (Tasks 1–4).
- `docs/production-readiness-audit-2026-06-17.md` — mark SEC-1 fixed (Task 5).

---

### Task 1: Schema + migration + RefreshTokenService (issue/rotate) + rotate login & refresh

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260617000000_add_refresh_tokens/migration.sql`
- Create: `src/auth/refresh-token.service.ts`
- Modify: `src/auth/strategies/jwt.strategy.ts` (add `RefreshJwtPayload`)
- Modify: `src/auth/auth.service.ts` (login issues a family; refresh rotates)
- Modify: `src/auth/auth.module.ts` (provide `RefreshTokenService`)
- Test: `test/auth-refresh-rotation.e2e-spec.ts` (new)

**Interfaces:**
- Produces: `RefreshTokenService` with
  - `issue(userId: string): Promise<{ jti: string; familyId: string }>`
  - `rotate(jti: string, userId: string): Promise<{ jti: string; familyId: string }>` (throws `UnauthorizedDomainError` on missing/wrong-user/REVOKED; on CONSUMED revokes the family then throws)
  - (added in later tasks: `revokeFamilyByJti`, `revokeAllForUser`, `purgeExpired`)
- Produces: `RefreshJwtPayload { sub: string; jti: string }`.
- Consumes: `PrismaService`, `ConfigService`, `UnauthorizedDomainError`, `ms`, `randomUUID`.

- [ ] **Step 1: Ensure `ms` is a direct dependency**

Run: `npm ls ms` — if it is not listed as a direct dependency of this package, run `npm install ms`. (`src/auth/auth.service.ts` already imports `type { StringValue } from 'ms'`, so the package resolves; this just makes the runtime `import ms from 'ms'` safe.)

- [ ] **Step 2: Add the schema model + enum + relation** — in `prisma/schema.prisma`, add:

```prisma
model RefreshToken {
  id           String             @id
  userId       String             @map("user_id")
  familyId     String             @map("family_id")
  status       RefreshTokenStatus @default(ACTIVE)
  expiresAt    DateTime           @map("expires_at")
  createdAt    DateTime           @default(now()) @map("created_at")
  consumedAt   DateTime?          @map("consumed_at")
  replacedById String?            @map("replaced_by_id")
  user         User               @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([familyId])
  @@index([expiresAt])
  @@map("refresh_tokens")
}

enum RefreshTokenStatus {
  ACTIVE
  CONSUMED
  REVOKED
}
```
And add the inverse relation to the `User` model (alongside its other fields):

```prisma
  refreshTokens RefreshToken[]
```

- [ ] **Step 3: Hand-author the migration** — create `prisma/migrations/20260617000000_add_refresh_tokens/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "RefreshTokenStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'REVOKED');

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "status" "RefreshTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),
    "replaced_by_id" TEXT,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: success; `prisma.client.refreshToken` and the `RefreshTokenStatus` enum become available to TypeScript. (If it errors on `DATABASE_URL`, the dev `.env` provides it — run via the project's normal dev env.)

- [ ] **Step 5: Write the failing e2e** — create `test/auth-refresh-rotation.e2e-spec.ts`. Mirror the bootstrap of `test/auth.e2e-spec.ts` (testcontainer, `makePrismaOverride`, `overrideProvider(PrismaService)`, `enableVersioning`, `ValidationPipe`, `AllExceptionsFilter`, create a user via `UsersService`). Use the HTTP `/v1/auth/login` + `/v1/auth/refresh` endpoints.

```typescript
  it('rotates the refresh token and invalidates the previous one', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const first = (login.body as { refreshToken: string }).refreshToken;

    const refreshed = await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = (refreshed.body as { refreshToken: string }).refreshToken;
    expect(second).not.toBe(first);

    // The new token works...
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: second })
      .expect(200);
  });

  it('detects reuse: replaying a consumed token revokes the family', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const original = (login.body as { refreshToken: string }).refreshToken;

    const refreshed = await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(200);
    const rotated = (refreshed.body as { refreshToken: string }).refreshToken;

    // Replay the now-consumed original → 401 (reuse detected).
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(401);

    // The family is revoked, so the rotated token is now dead too.
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated })
      .expect(401);
  });
```
(Use the file's own helper for `server()`/the supertest app handle, matching `auth.e2e-spec.ts`. The user `rot@test.io` is created once in `beforeAll`.)

- [ ] **Step 6: Run the e2e to verify it fails**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: FAIL — today refresh is stateless: rotation returns a token but the *old* token still refreshes (so the reuse test's `.expect(401)` fails), and there is no row to consume.

- [ ] **Step 7: Add the `RefreshJwtPayload` type** — in `src/auth/strategies/jwt.strategy.ts`, add (next to `JwtPayload`):

```typescript
export interface RefreshJwtPayload {
  sub: string;
  jti: string;
}
```

- [ ] **Step 8: Create `RefreshTokenService`** — `src/auth/refresh-token.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import ms, { StringValue } from 'ms';
import { PrismaService } from '../common/prisma/prisma.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private expiresAt(): Date {
    const ttl = this.config.getOrThrow<string>('JWT_REFRESH_TTL') as StringValue;
    return new Date(Date.now() + ms(ttl));
  }

  /** Start a new session family and issue its first refresh-token row. */
  async issue(userId: string): Promise<{ jti: string; familyId: string }> {
    const jti = randomUUID();
    const familyId = randomUUID();
    await this.prisma.client.refreshToken.create({
      data: { id: jti, userId, familyId, expiresAt: this.expiresAt() },
    });
    return { jti, familyId };
  }

  /**
   * Rotate an ACTIVE refresh token: consume it and issue a successor in the same
   * family. Replaying a CONSUMED token (theft signal) revokes the whole family.
   * The consume + create (and the family revoke) are atomic.
   */
  async rotate(
    jti: string,
    userId: string,
  ): Promise<{ jti: string; familyId: string }> {
    return this.prisma.client.$transaction(async (tx) => {
      const row = await tx.refreshToken.findUnique({ where: { id: jti } });
      if (!row || row.userId !== userId || row.status === 'REVOKED') {
        throw new UnauthorizedDomainError('Invalid refresh token');
      }
      if (row.status === 'CONSUMED') {
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId },
          data: { status: 'REVOKED' },
        });
        throw new UnauthorizedDomainError('Invalid refresh token');
      }
      const newJti = randomUUID();
      await tx.refreshToken.update({
        where: { id: jti },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
          replacedById: newJti,
        },
      });
      await tx.refreshToken.create({
        data: {
          id: newJti,
          userId,
          familyId: row.familyId,
          expiresAt: this.expiresAt(),
        },
      });
      return { jti: newJti, familyId: row.familyId };
    });
  }
}
```

- [ ] **Step 9: Rewrite login + refresh in `AuthService`** — in `src/auth/auth.service.ts`: inject `RefreshTokenService`, change the refresh payload type to `RefreshJwtPayload`, and route token issuance through a jti. Constructor gains `private readonly refreshTokens: RefreshTokenService`. Replace `refresh` and `issueTokens`, and update `login`'s return:

```typescript
  // login(): after the constant-time verify + guard (UNCHANGED), replace the
  // `return this.issueTokens(...)` line with:
    const { jti } = await this.refreshTokens.issue(user.id);
    return this.issueTokens(
      { id: user.id, email: user.email, role: user.role },
      jti,
    );
```

```typescript
  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshJwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    const { jti } = await this.refreshTokens.rotate(payload.jti, user.id);
    return this.issueTokens(
      { id: user.id, email: user.email, role: user.role },
      jti,
    );
  }

  private async issueTokens(
    user: AuthenticatedUser,
    jti: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.getOrThrow<string>(
          'JWT_ACCESS_TTL',
        ) as StringValue,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.getOrThrow<string>(
          'JWT_REFRESH_TTL',
        ) as StringValue,
      },
    );
    return { accessToken, refreshToken };
  }
```
Add the imports: `RefreshJwtPayload` from `./strategies/jwt.strategy`, `RefreshTokenService` from `./refresh-token.service`. Keep `import type { StringValue } from 'ms'`. The SEC-6 constant-time `login` credential check (and `verifyPasswordOrDecoy`) stays exactly as is — only the final issuance line changes.

- [ ] **Step 10: Register the provider** — in `src/auth/auth.module.ts`, add `RefreshTokenService` to `providers` (import it). (`PrismaModule` is `@Global`, so `PrismaService` resolves.)

- [ ] **Step 11: Run the e2e to verify it passes**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: PASS — rotation returns a new token and the old one 401s; replaying a consumed token 401s and kills the family. Also run `npm run test:e2e -- auth` to confirm the existing auth e2e (login, wrong password, unknown user, `me`) stays green.

- [ ] **Step 12: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/auth/refresh-token.service.ts src/auth/auth.service.ts src/auth/strategies/jwt.strategy.ts src/auth/auth.module.ts test/auth-refresh-rotation.e2e-spec.ts --max-warnings 0
git add -A
git commit -m "feat(auth): stateful refresh tokens with rotation + reuse detection (SEC-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Logout (revoke the current session family)

**Files:**
- Modify: `src/auth/refresh-token.service.ts` (add `revokeFamilyByJti`)
- Modify: `src/auth/auth.service.ts` (add `logout`)
- Create: `src/auth/dto/logout.dto.ts`
- Modify: `src/auth/auth.controller.ts` (add the `logout` route)
- Test: `test/auth-refresh-rotation.e2e-spec.ts` (add a logout test)

**Interfaces:**
- Consumes: `RefreshTokenService.rotate`/`issue` (Task 1), `RefreshJwtPayload`, `OkFlagDto`.
- Produces: `RefreshTokenService.revokeFamilyByJti(jti: string): Promise<void>`; `AuthService.logout(refreshToken: string): Promise<{ ok: true }>`; `POST /v1/auth/logout`.

- [ ] **Step 1: Write the failing test** — add to `test/auth-refresh-rotation.e2e-spec.ts`:

```typescript
  it('logout revokes the session: the token can no longer refresh', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const token = (login.body as { refreshToken: string }).refreshToken;

    await request(server())
      .post('/v1/auth/logout')
      .send({ refreshToken: token })
      .expect(201)
      .expect((r) => expect((r.body as { ok: boolean }).ok).toBe(true));

    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });
```
(Note: `POST` defaults to 201 unless `@HttpCode` is set — the controller route below does not set `@HttpCode`, so expect 201.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: FAIL — `/v1/auth/logout` does not exist yet (404).

- [ ] **Step 3: Add `revokeFamilyByJti`** — append to `RefreshTokenService`:

```typescript
  /** Revoke the entire family of the given token (logout one device). No-op if unknown. */
  async revokeFamilyByJti(jti: string): Promise<void> {
    const row = await this.prisma.client.refreshToken.findUnique({
      where: { id: jti },
    });
    if (!row) return;
    await this.prisma.client.refreshToken.updateMany({
      where: { familyId: row.familyId },
      data: { status: 'REVOKED' },
    });
  }
```

- [ ] **Step 4: Add `logout` to `AuthService`**:

```typescript
  async logout(refreshToken: string): Promise<{ ok: true }> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshJwtPayload>(
        refreshToken,
        { secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET') },
      );
      await this.refreshTokens.revokeFamilyByJti(payload.jti);
    } catch {
      // Idempotent: an invalid/expired/unknown token has nothing to revoke.
    }
    return { ok: true };
  }
```

- [ ] **Step 5: Create the DTO** — `src/auth/dto/logout.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class LogoutDto {
  @IsString()
  refreshToken!: string;
}
```

- [ ] **Step 6: Add the controller route** — in `src/auth/auth.controller.ts`, import `LogoutDto`, `OkFlagDto` (already imported), and `Public` (already imported); add:

```typescript
  @Public()
  @Throttle({
    default: {
      ttl: 60_000,
      limit: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30,
    },
  })
  @Post('logout')
  @ApiOkResponse({ type: OkFlagDto })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.auth.logout(dto.refreshToken);
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: PASS — logout returns `{ ok: true }` and the token then 401s on refresh.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/auth/refresh-token.service.ts src/auth/auth.service.ts src/auth/dto/logout.dto.ts src/auth/auth.controller.ts test/auth-refresh-rotation.e2e-spec.ts --max-warnings 0
git add -A
git commit -m "feat(auth): logout endpoint revokes the refresh-token family (SEC-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Logout-all (revoke every session) + multi-session isolation

**Files:**
- Modify: `src/auth/refresh-token.service.ts` (add `revokeAllForUser`)
- Modify: `src/auth/auth.service.ts` (add `logoutAll`)
- Modify: `src/auth/auth.controller.ts` (add the authed `logout-all` route)
- Test: `test/auth-refresh-rotation.e2e-spec.ts` (logout-all + isolation)

**Interfaces:**
- Consumes: `@CurrentUser`/`AuthenticatedUser`, `OkFlagDto`.
- Produces: `RefreshTokenService.revokeAllForUser(userId: string): Promise<void>`; `AuthService.logoutAll(userId: string): Promise<{ ok: true }>`; `POST /v1/auth/logout-all` (authenticated).

- [ ] **Step 1: Write the failing tests** — add to `test/auth-refresh-rotation.e2e-spec.ts`:

```typescript
  it('logout-all revokes every session for the user', async () => {
    const a = await request(server()).post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' }).expect(200);
    const b = await request(server()).post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' }).expect(200);
    const tA = (a.body as { refreshToken: string }).refreshToken;
    const tB = (b.body as { refreshToken: string }).refreshToken;
    const access = (a.body as { accessToken: string }).accessToken;

    await request(server())
      .post('/v1/auth/logout-all')
      .set('Authorization', `Bearer ${access}`)
      .expect(201)
      .expect((r) => expect((r.body as { ok: boolean }).ok).toBe(true));

    await request(server()).post('/v1/auth/refresh').send({ refreshToken: tA }).expect(401);
    await request(server()).post('/v1/auth/refresh').send({ refreshToken: tB }).expect(401);
  });

  it('logout of one session leaves other sessions working', async () => {
    const a = await request(server()).post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' }).expect(200);
    const b = await request(server()).post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' }).expect(200);
    const tA = (a.body as { refreshToken: string }).refreshToken;
    const tB = (b.body as { refreshToken: string }).refreshToken;

    await request(server()).post('/v1/auth/logout').send({ refreshToken: tA }).expect(201);

    await request(server()).post('/v1/auth/refresh').send({ refreshToken: tA }).expect(401);
    await request(server()).post('/v1/auth/refresh').send({ refreshToken: tB }).expect(200);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: FAIL — `/v1/auth/logout-all` does not exist (404). (The isolation test would pass already, but the logout-all test drives the new route.)

- [ ] **Step 3: Add `revokeAllForUser`** — append to `RefreshTokenService`:

```typescript
  /** Revoke every session for a user (logout all devices). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { userId },
      data: { status: 'REVOKED' },
    });
  }
```

- [ ] **Step 4: Add `logoutAll` to `AuthService`**:

```typescript
  async logoutAll(userId: string): Promise<{ ok: true }> {
    await this.refreshTokens.revokeAllForUser(userId);
    return { ok: true };
  }
```

- [ ] **Step 5: Add the authed controller route** — in `src/auth/auth.controller.ts`, add (it is authed by the global `JwtAuthGuard`, so no `@Public`):

```typescript
  @Post('logout-all')
  @ApiOkResponse({ type: OkFlagDto })
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ ok: true }> {
    return this.auth.logoutAll(user.id);
  }
```
(`CurrentUser` and `AuthenticatedUser` are already imported in the controller.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: PASS — logout-all 401s both sessions; logging out one session leaves the other refreshing.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/auth/refresh-token.service.ts src/auth/auth.service.ts src/auth/auth.controller.ts test/auth-refresh-rotation.e2e-spec.ts --max-warnings 0
git add -A
git commit -m "feat(auth): logout-all revokes every user session (SEC-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Scheduled cleanup of expired refresh tokens

**Files:**
- Modify: `src/auth/refresh-token.service.ts` (add `purgeExpired`)
- Create: `src/auth/refresh-token-purge.service.ts`
- Modify: `src/auth/auth.module.ts` (register the purge service)
- Test: `test/auth-refresh-rotation.e2e-spec.ts` (purge predicate)

**Interfaces:**
- Consumes: `@nestjs/schedule` `@Cron`/`CronExpression` (already a dependency; `ScheduleModule.forRoot()` is already in `AppModule`), `RefreshTokenService`.
- Produces: `RefreshTokenService.purgeExpired(): Promise<number>`; `RefreshTokenPurgeService` running it hourly.

- [ ] **Step 1: Write the failing test** — add to `test/auth-refresh-rotation.e2e-spec.ts` (uses `prisma.client` + the service directly; import `RefreshTokenService` from `../src/auth/refresh-token.service` and get it via `app.get(...)`):

```typescript
  it('purgeExpired deletes only rows past their expiry', async () => {
    const svc = app.get(RefreshTokenService);
    const userId = (await prisma.client.user.findFirst({
      where: { email: 'rot@test.io' },
    }))!.id;
    await prisma.client.refreshToken.create({
      data: {
        id: 'expired-1', userId, familyId: 'fam-x',
        status: 'CONSUMED',
        expiresAt: new Date('2000-01-01'), // past
      },
    });
    await prisma.client.refreshToken.create({
      data: {
        id: 'fresh-1', userId, familyId: 'fam-y',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60_000), // future
      },
    });
    const deleted = await svc.purgeExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.client.refreshToken.findUnique({ where: { id: 'expired-1' } })).toBeNull();
    expect(await prisma.client.refreshToken.findUnique({ where: { id: 'fresh-1' } })).not.toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: FAIL — `purgeExpired` does not exist (compile error).

- [ ] **Step 3: Add `purgeExpired`** — append to `RefreshTokenService`:

```typescript
  /**
   * Hard-delete rows past their expiry. CONSUMED/REVOKED rows are kept until they
   * expire so a replay within the TTL is still detectable. Returns the count.
   */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.client.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
```

- [ ] **Step 4: Create the purge cron service** — `src/auth/refresh-token-purge.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RefreshTokenService } from './refresh-token.service';

/** Hourly cleanup of expired refresh-token rows. */
@Injectable()
export class RefreshTokenPurgeService {
  private readonly logger = new Logger(RefreshTokenPurgeService.name);

  constructor(private readonly refreshTokens: RefreshTokenService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const count = await this.refreshTokens.purgeExpired();
    if (count > 0) {
      this.logger.log(`Purged ${count} expired refresh tokens`);
    }
  }
}
```

- [ ] **Step 5: Register the provider** — in `src/auth/auth.module.ts`, add `RefreshTokenPurgeService` to `providers` (import it). (`ScheduleModule.forRoot()` is already registered in `AppModule` from SEC-2.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e -- auth-refresh-rotation`
Expected: PASS — the expired row is deleted, the fresh row survives.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/auth/refresh-token.service.ts src/auth/refresh-token-purge.service.ts src/auth/auth.module.ts test/auth-refresh-rotation.e2e-spec.ts --max-warnings 0
git add -A
git commit -m "feat(auth): hourly cleanup of expired refresh tokens (SEC-1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full-suite verification + audit doc update

**Files:**
- Modify: `docs/production-readiness-audit-2026-06-17.md`

- [ ] **Step 1: Run the full unit + e2e suites**

```bash
npm test
npm run test:e2e
npm run typecheck
```
Expected: all unit suites pass; all e2e suites pass (adds `auth-refresh-rotation.e2e-spec`); typecheck clean. Report the actual totals and confirm 0 failures. If anything fails, STOP and report BLOCKED with the failing suite/test + a tight excerpt — do not edit the doc.

- [ ] **Step 2: Mark SEC-1 fixed** in `docs/production-readiness-audit-2026-06-17.md` — add a one-line "✅ FIXED (branch fix/refresh-token-revocation)" note to SEC-1 in §2, noting: stateful `RefreshToken` table, rotation-on-use, reuse detection (family revocation), logout/logout-all; access tokens remain short-lived/stateless by design. Match the doc's existing formatting; do not alter the original finding text.

- [ ] **Step 3: Commit**

```bash
git add docs/production-readiness-audit-2026-06-17.md
git commit -m "docs(audit): mark SEC-1 (refresh-token revocation) fixed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — schema/migration + token model + rotation + reuse-detection → T1; logout (family) → T2; logout-all + multi-session isolation → T3; scheduled cleanup → T4; full-suite verify + audit-doc update → T5. The spec's "first slice bundles login-issue + refresh-rewrite" note is honored (T1 rewrites both together). Out-of-scope items (per-request access-token revocation, tokenHash, session-list, device metadata) are intentionally absent. No gaps.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test step shows the full test; the one "mirror `auth.e2e-spec.ts`'s bootstrap" instruction (T1 Step 5) points the implementer at a concrete existing file for the harness rather than guessing helper names — the same pattern used in the §1/§2 plans.

**Type consistency:** `RefreshTokenService` method signatures are defined in T1 (`issue`, `rotate`) and extended in T2 (`revokeFamilyByJti`), T3 (`revokeAllForUser`), T4 (`purgeExpired`), all `Promise`-returning with the exact names the callers use. `RefreshJwtPayload { sub; jti }` (T1) is used by `refresh` and `logout`. `issueTokens(user: AuthenticatedUser, jti: string)` (T1) is called by `login`, `refresh`. `{ ok: true }` responses use the existing `OkFlagDto`. `RefreshTokenStatus` string literals (`'ACTIVE'`/`'CONSUMED'`/`'REVOKED'`) match the enum. Migration table/column names (`refresh_tokens`, `user_id`, `family_id`, `expires_at`, `consumed_at`, `replaced_by_id`) match the `@map` names in the schema.

**Decisions honored:** JWT+jti token form (T1); family-scoped reuse revocation (T1) and logout (T2) vs all-sessions logout-all (T3); access token unchanged/stateless; cleanup keeps CONSUMED/REVOKED until expiry (T4); no new env var.
