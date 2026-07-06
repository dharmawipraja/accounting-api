# User Management — Design

**Date:** 2026-07-07
**Status:** Approved (brainstormed with operator; three decisions recorded below)

## Problem

The API has authentication and four roles (VIEWER/ACCOUNTANT/APPROVER/ADMIN) but
no user management surface at all: `UsersService` is internal-only, and the only
way to create any user is the CLI `create-admin` script — which creates ADMINs
exclusively. In production there is no way to create an ACCOUNTANT/APPROVER/
VIEWER, reset a forgotten password, deactivate a leaver, or change a role,
even though the draft→post approval flow presupposes multiple users.

## Decisions (made by the operator)

1. **Passwords:** admin create/reset returns a generated one-time temp password
   (shown exactly once in the response); the user is then forced to change it
   before doing anything else. Admins never know long-term passwords. No email
   infrastructure exists or is added.
2. **Revocation semantics:** immediate. Auth becomes per-request-fresh (DB read
   in `JwtStrategy.validate`) so deactivation and role changes take effect on
   the next request, not after token expiry.
3. **Admin rules:** ADMINs manage all users including other ADMINs, guarded by:
   no self-role-change, no self-deactivate/delete, and the last active ADMIN
   cannot be demoted/deactivated/deleted.

## Architecture

### Freshness mechanism (approach A — chosen over alternatives)

`JwtStrategy.validate()` becomes async and loads the user by PK on every
authenticated request:

- user missing, soft-deleted, or `isActive=false` → 401;
- `req.user` (`AuthenticatedUser`) is built from the **DB row**, not the token
  payload — so `RolesGuard` sees live roles with no other change;
- `AuthenticatedUser` gains `mustChangePassword: boolean`.

Rejected alternatives: a separate global `UserStateGuard` (same read, more
guard-ordering surface) and revocation-only staleness (ruled out by decision 2).
Cost: one indexed PK read per authenticated request; `HighLatencyP95` and the
`db_pool_*` gauges will surface it if it ever matters at this scale.

### Schema

One migration: `mustChangePassword Boolean @default(false)` (`must_change_password`)
on `User`. Everything else (soft delete, email tombstoning, argon2) exists.

### Endpoints — `/v1/users` (new `UsersController`, all `@Roles(ADMIN)`)

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/users` | Body `{email, name, role}`. Generates a temp password (crypto-random, ~16 chars, charset excluding ambiguous chars), creates the user with `mustChangePassword=true`, returns `201 { user, tempPassword }` — the only time the temp password is visible. Duplicate email → 409 via the unique constraint. |
| `GET /v1/users` | `{data,total,limit,offset}` envelope (default 50 / max 200), optional `?role=` and `?isActive=` filters. **No `?q=`** — small bounded set (client-side filtering, same rationale as accounts/tax-codes). |
| `GET /v1/users/:id` | Single user; 404 when missing/soft-deleted. |
| `PATCH /v1/users/:id` | Any of `{name, role, isActive}`. Role change or deactivation revokes the target's refresh-token families. Safety rails below. |
| `POST /v1/users/:id/reset-password` | New temp password returned once; `mustChangePassword=true`; all the target's refresh families revoked. Naturally retryable. |
| `DELETE /v1/users/:id` | Soft delete via the existing tombstone helper (email becomes reusable); revokes refresh families; 204. |

**No `@IdempotentWrite` on any user endpoint** — deliberate: creates are deduped
by the unique email (consistent with partners/accounts/tax-codes), reset is
naturally re-runnable, and exempting them keeps temp passwords out of the
idempotency response cache (`idempotency_keys.response` stores raw JSON).

### Self-service — `POST /v1/auth/change-password` (any authenticated user)

Body `{currentPassword, newPassword}` (`newPassword`: `@MinLength(8)`,
`@MaxLength(128)`). Re-verifies the current password (argon2), re-hashes,
clears `mustChangePassword`, and revokes **all** the user's refresh families
(the current access token stays valid ≤15 min; other devices die immediately).
Revoking only *other* families is impossible here — change-password carries
the access token, which has no refresh-family identity. Wrong current
password → 401-family domain error.

### Forced-change enforcement

A small global guard (registered after `RolesGuard`) rejects any request from a
user with `mustChangePassword=true` with **`403 PASSWORD_CHANGE_REQUIRED`**
(stable machine code for the frontend to redirect on), except handlers marked
`@AllowWithPendingPassword()`: `POST /v1/auth/change-password`, `GET /v1/auth/me`,
`POST /v1/auth/logout`, `POST /v1/auth/logout-all`. `@Public()` routes are
untouched (the guard only runs for authenticated requests).

### Safety rails (enforced in the service; all → 422)

- Acting on yourself: cannot change your own role, set your own `isActive=false`,
  or delete yourself. (Changing your own name is allowed.)
- Last-admin protection: a role change away from ADMIN, deactivation, or delete
  that would leave **zero active ADMINs** is refused.
- Concurrency: the last-admin check runs inside a `$transaction` holding a
  `pg_advisory_xact_lock` on a constant key (same pattern as year-end close),
  so two admins demoting each other concurrently cannot both pass the count.

### Free from existing infrastructure

- **Audit:** the global interceptor records every mutation; `audit-sanitize`
  already redacts keys matching `/password/i`, which covers `tempPassword` and
  the change-password body.
- **OpenAPI:** named DTOs (`UserResponseDto`, `CreateUserResponseDto` with the
  one-time `tempPassword`, `PaginatedUsersResponseDto`, …), `passwordHash`
  never serialized; `npm run openapi:export` + the schema-guard test.
- **Rate limiting / timeouts / error envelope:** global, nothing to add.

## Error semantics

| Case | Status / code |
| --- | --- |
| Duplicate email on create | 409 CONFLICT |
| Unknown/soft-deleted user id | 404 NOT_FOUND |
| Self role-change / self-deactivate / self-delete / last-admin violations | 422 VALIDATION_FAILED |
| Wrong `currentPassword` on change-password | 401 UNAUTHORIZED |
| Any request while `mustChangePassword=true` (outside the allowlist) | 403 PASSWORD_CHANGE_REQUIRED |
| Deactivated/deleted user with a live access token | 401 on the next request |

## Testing

- **E2E (`users-management.e2e-spec.ts`, `bootstrapTestApp`)**: full lifecycle —
  ADMIN creates user → login with temp password → non-allowlisted call → 403
  `PASSWORD_CHANGE_REQUIRED` → change password → works; role change effective on
  the next request (no re-login); deactivation → immediate 401; reset-password
  revokes refresh tokens (old refresh → 401); last-admin and self-guards → 422;
  non-ADMIN calling any `/v1/users` endpoint → 403; list envelope + filters.
- **Unit (pure code only, per the coverage convention)**: temp-password
  generator (length/charset/uniqueness), guard allowlist decorator metadata.
- The existing 290-test e2e suite regression-guards the `JwtStrategy` change —
  every authenticated request in it now exercises the per-request DB check.
- Full merged coverage gate (`npm run test:cov:all`, 90/86/90/90) before merge.

## Documentation

- `docs/api/frontend-guide.md`: new Users section (endpoints, role matrix
  addition, `PASSWORD_CHANGE_REQUIRED` handling + forced-change flow).
- `docs/api/frontend-agent-brief.md`: new rule for the 403 code + temp-password
  UX (show once, force change).
- `docs/runbooks/operator-activation.md` / `local-development.md`: note that
  `create-admin` is now bootstrap-only; day-to-day user admin happens in-API.
- `npm run openapi:export` refresh.

## Out of scope (deliberate)

- Email-based password reset / invitations (no SMTP in the stack).
- Password complexity policies beyond min-length, lockouts, MFA, password
  history (pull when a requirement exists).
- `?q=` search on users (small set).
- Per-request user-row caching (add only if the latency histogram says so).
