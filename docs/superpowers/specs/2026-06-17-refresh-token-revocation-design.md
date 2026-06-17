# SEC-1: Refresh-token revocation/rotation — design

**Date:** 2026-06-17
**Branch:** `fix/refresh-token-revocation` (off `main` @ `2656ee8`)
**Source:** SEC-1 (High) of `docs/production-readiness-audit-2026-06-17.md`.

## Goal

Make refresh tokens stateful and revocable. Today `AuthService.refresh` is stateless: it verifies a refresh JWT's signature + `isActive` + expiry and reissues, with **no rotation** (the old token stays valid for its full 7-day TTL) and **no revocation path**. This design adds rotation-on-use, reuse (theft) detection, and logout, backed by a `RefreshToken` table. The access token stays a short-lived stateless JWT — unchanged.

## Scope

A single cohesive subsystem: the refresh-token lifecycle (issue → rotate → revoke), reuse detection, and logout endpoints, plus scheduled cleanup. One Prisma migration (a new table + enum). The access-token path, login's credential check (SEC-6 constant-time), and throttling are unchanged except where noted.

## Resolved decisions

1. **Strategy:** persisted `RefreshToken` table with rotation-on-every-refresh + reuse detection (not the minimal `tokenVersion` approach).
2. **Token form:** the refresh token stays a **JWT** carrying a `jti` (+ `sub`), signed with `JWT_REFRESH_SECRET`, `expiresIn = JWT_REFRESH_TTL` (unchanged 7d). The `jti` (a random uuid) is the `RefreshToken` row id; the JWT signature authenticates, the row tracks lifecycle. No raw token or token hash is stored (redundant given JWT+jti; an optional `tokenHash` is noted as possible future hardening, not implemented).
3. **Reuse-detection scope:** replaying a `CONSUMED` token revokes the **family** (that session's token chain), not all of the user's sessions.
4. **Logout scope:** `logout` revokes the current token's **family** (one device); `logout-all` revokes **all** the user's sessions.
5. **Access tokens are not revocable mid-life** — a revoked session's access token stays valid until it expires (short `JWT_ACCESS_TTL`). Per-request denylist checks on the hot path are explicitly out of scope.
6. **No new env var** — `expiresAt` derives from `JWT_REFRESH_TTL`.

## Schema (hand-authored migration)

```prisma
model RefreshToken {
  id           String             @id            // = the JWT jti (uuid)
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
`User` gains the inverse relation `refreshTokens RefreshToken[]`. The refresh JWT payload gains `jti`. `RefreshToken` is **not** a soft-delete model (rows are hard-deleted by cleanup). Migration is hand-authored (per the project's `prisma migrate` convention).

## Token model & flow

### Issue (login)
On successful login: generate `familyId = uuid()` and `jti = uuid()`; sign a refresh JWT `{ sub, jti }` with `expiresIn = JWT_REFRESH_TTL`; insert one `RefreshToken { id: jti, userId, familyId, status: ACTIVE, expiresAt: now + TTL }`; return `{ accessToken, refreshToken }`. Each login is an independent family (multi-device sessions).

### Refresh (rotation + reuse detection) — one transaction
1. Verify the refresh JWT (signature + exp) with `JWT_REFRESH_SECRET`; on failure → 401 (`UnauthorizedDomainError`, "Invalid refresh token").
2. Load the user by `payload.sub`; if absent or `!isActive` → 401 (unchanged behavior).
3. Look up the row by `jti`:
   - **not found** → 401 (revoked/purged/forged jti).
   - **status REVOKED** → 401.
   - **status CONSUMED** → **reuse detected**: set every row with that `familyId` to `REVOKED`; throw 401. (A rotated-away token is being replayed — kill the session chain.)
   - **status ACTIVE** → rotate: set this row `CONSUMED` (`consumedAt = now`, `replacedById = newJti`); insert a new `ACTIVE` row `{ id: newJti, userId, familyId (same), expiresAt: now + TTL }`; sign new access + refresh (carrying `newJti`); return the pair.

The consume-old + create-new (and the family-revoke) happen atomically in a `prisma.$transaction` so a crash can't leave two active tokens or a half-rotated state.

### Endpoints
- `POST /v1/auth/logout` `{ refreshToken }` — **Public**. Verify the JWT; if it resolves to a known row, set that row's **family** to `REVOKED`. Always returns `{ ok: true }` — unknown/already-revoked/expired tokens also return ok (idempotent, no enumeration). Throttled consistently with the other auth routes.
- `POST /v1/auth/logout-all` — **authenticated** (access token, `@CurrentUser`). Set all the user's `RefreshToken` rows to `REVOKED`. Returns `{ ok: true }`.
- `login` and `refresh` keep their routes, DTOs, response shape (`{ accessToken, refreshToken }`), and throttles.

### Cleanup
A `@nestjs/schedule` `@Cron` (hourly, reusing the SEC-2 scheduler infra) hard-deletes rows where `expiresAt < now`. CONSUMED/REVOKED rows are retained until expiry so a replay within the TTL is still detectable. Extract the delete as a testable service method (`RefreshTokenService.purgeExpired()`), called by the cron.

## Components (file boundaries)

- `prisma/schema.prisma` + a new hand-authored migration — the table + enum + relation.
- `src/auth/refresh-token.service.ts` (new) — the lifecycle: `issue(userId)`, `rotate(jti, userId)`, `revokeFamily(familyId)`, `revokeAllForUser(userId)`, `purgeExpired()`. Owns all `RefreshToken` table access; returns/accepts plain data so it's unit-testable.
- `src/auth/auth.service.ts` — `login`/`refresh` call `RefreshTokenService`; add `logout(refreshToken)` and `logoutAll(userId)`. Keep the SEC-6 constant-time login intact.
- `src/auth/strategies/jwt.strategy.ts` / refresh payload type — add `jti` to the refresh payload (a separate `RefreshJwtPayload` type; the access `JwtPayload` is unchanged).
- `src/auth/auth.controller.ts` — add `logout` (Public) and `logout-all` (authed) routes + DTOs/response models.
- `src/auth/refresh-token-purge.service.ts` (new) — the `@Cron` calling `purgeExpired()` (mirrors `IdempotencyPurgeService`).
- `src/auth/auth.module.ts` — register the new providers.

Keeping all table access in `RefreshTokenService` (one clear responsibility, well-defined interface) keeps `AuthService` focused on auth orchestration and makes the rotation/reuse logic unit-testable in isolation.

## Testing strategy (TDD — RED first)

Real-Postgres e2e (the table predicates and transaction must be exercised against a real DB — the FIN-L2/SEC-2 lesson that mocked Prisma can't validate `where`):
- **Rotation:** login → refresh returns a *new* refresh token; the *old* refresh token then fails (401) — rotation invalidates the predecessor.
- **Reuse detection:** login → refresh (rotates) → replay the *original* (now CONSUMED) token → 401 AND the family is revoked, so the *rotated* token also stops working afterward.
- **Logout:** login → logout → that token (and its family) can no longer refresh (401).
- **Logout-all:** two logins (two families) → logout-all → both families' tokens fail.
- **Multi-session isolation:** two families → logout one → the other still refreshes.
- **Deactivated user:** `isActive=false` → refresh 401 (unchanged).
- **Cleanup:** `purgeExpired()` deletes only rows past `expiresAt`; a still-valid CONSUMED row (needed for reuse detection) survives.

Unit tests for `RefreshTokenService` family-revocation / reuse branches where a focused unit is clearer than an e2e.

## Delivery

- Commit 1: schema + hand-authored migration + `RefreshTokenService.issue` wired into login (login persists a family; refresh still stateless at this point won't compile against the new flow — so this slice includes the refresh rewrite). Practically: slice by test-first vertical increments (issue-on-login + rotation; reuse-detection; logout; logout-all; cleanup), one commit each, the migration landing in the first.
- After each: `npm run typecheck`, `eslint --max-warnings 0` on changed files, the relevant e2e. Full unit + e2e suite before finishing.
- Migrations: follow the repo's hand-authored migration workflow; the e2e testcontainer applies migrations on boot.
- Branch `fix/refresh-token-revocation` → fast-forward merge to `main` (no remote configured).
- Mark SEC-1 fixed in `docs/production-readiness-audit-2026-06-17.md`.

## Risks

- **Transaction correctness:** rotation (consume-old + create-new) and family-revocation must be atomic — all in one `prisma.$transaction`. A non-atomic rotation could leave two ACTIVE tokens (defeats single-use) or none (locks the user out of that session). Covered by the rotation + reuse e2e.
- **Refresh race (double-submit):** two concurrent refreshes with the same ACTIVE token — the first consumes it, the second sees CONSUMED → reuse-detection revokes the family. This is correct (a legit client shouldn't double-submit) but means a buggy client that fires two refreshes loses its session. Acceptable and standard; noted so it isn't mistaken for a bug.
- **Access-token lag:** a revoked session's access token works until it expires (≤ `JWT_ACCESS_TTL`). Accepted (decision 5); the short access TTL bounds it.
- **Migration:** a new table only (no backfill, no change to existing rows) — low-risk; existing stateless refresh tokens issued before deploy will simply fail the new jti lookup (their holders re-login). Note for deploy: in-flight sessions are invalidated at cutover.

## Out of scope (deferred / not built)

- Per-request access-token revocation / denylist (decision 5).
- Device/IP/user-agent metadata on sessions (YAGNI for an internal API; the table can gain columns later).
- A "list my sessions" endpoint.
- The `tokenHash` defense-in-depth column (optional future hardening).
