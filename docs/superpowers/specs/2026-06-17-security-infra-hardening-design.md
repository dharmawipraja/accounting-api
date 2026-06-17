# Security infra hardening (SEC-3 Caddy / SEC-7 audit-log / SEC-8 CI) — design

**Date:** 2026-06-17
**Branch:** `fix/security-infra-hardening` (off `main` @ `77d8daf`)
**Source:** the three remaining §2 findings of `docs/production-readiness-audit-2026-06-17.md` after SEC-1/2/4/5/6 and the SEC-3 app-side fix were merged.

## Goal

Close the remaining §2 Security & hardening items. These are **infra/ops**, not application features, so their verifiability differs:

- **SEC-7** — make `audit_log` append-only at the database. Implementable AND e2e-verifiable here. The one with a real test.
- **SEC-3** — have Caddy overwrite a spoofed inbound `X-Forwarded-For` (the deferred infra half of SEC-3). A `Caddyfile` change; **not** exercisable in the Jest harness (Caddy is not in the test path) → config + a documented deploy-time verification.
- **SEC-8** — activate CI. `ci.yml` and the `audit:ci` gate already exist; CI is dormant only because the repo has no git remote. **Docs only** — an operator action (push to GitHub). No code.

## Scope

Three independent infra items, one cohesive spec (all §2 ops hardening). One hand-authored SQL migration (a trigger), one `Caddyfile` edit, and runbook documentation. No application-code changes, no `schema.prisma` change, no new dependency.

## Resolved decisions

1. **SEC-7 mechanism: a `BEFORE UPDATE OR DELETE` trigger** that raises an exception — NOT the audit's `REVOKE … FROM <app role>`. The app and migrations both connect as the single `accounting` role that **owns** the tables; in Postgres a table owner bypasses `REVOKE` on its own tables and can re-grant, so `REVOKE` is a no-op. A trigger enforces append-only for **every** role (owner included) and is verifiable in the test harness.
2. **SEC-3 directive:** `header_up X-Forwarded-For {remote_host}` inside the `reverse_proxy` block — sets XFF to Caddy's real connecting-client IP, discarding any client-supplied value. Caddy is the TLS edge (clients connect directly), so `{remote_host}` is the true client. Verified at deploy time only.
3. **SEC-8:** documentation only — no code; `ci.yml` is already complete and correct.

## SEC-7 — `audit_log` append-only (DB trigger)

**File:** `prisma/migrations/20260617000001_audit_log_append_only/migration.sql` (hand-authored; SQL-only, no `schema.prisma` change — Prisma does not model triggers; consistent with the project's hand-authored-migration convention that avoids `migrate dev` drift).

```sql
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
```

`audit.service.ts` only ever `auditLog.create` (INSERT) and `findMany` (SELECT) — verified — so the trigger breaks nothing legitimate. It is strictly stronger than the audit's `REVOKE` suggestion (which the single owner role would bypass).

**Acceptance / test (e2e, real Postgres via testcontainers):** insert an `audit_log` row (e.g. `prisma.client.auditLog.create`), then attempt to mutate it via raw SQL — `prisma.client.$executeRawUnsafe('UPDATE audit_log SET path = $1 WHERE id = $2', …)` and a `DELETE` — and assert BOTH reject (the trigger raises). Confirm the row is unchanged after the failed attempts, and that a fresh INSERT still succeeds.

**Trade-off (documented):** the trigger also blocks any future retention-purge of old audit rows. This is the intended posture for an audit log (append-only forever). If retention is ever required, a privileged maintenance path (temporarily drop/recreate the trigger inside a maintenance migration, or a SECURITY DEFINER purge function) can be added then — out of scope now.

## SEC-3 — Caddy overwrites inbound X-Forwarded-For

**File:** `Caddyfile`.

**Current:** `reverse_proxy api:3000` with no XFF handling; Caddy appends the real client IP to any inbound `X-Forwarded-For`, so a client-supplied XFF survives and can skew the app's per-IP throttle (the app trusts the proxied XFF via `trust proxy: 1`).

**Change:** overwrite XFF with the true connecting client:
```
{$DOMAIN} {
	@metrics path /metrics
	respond @metrics "Not found" 404
	reverse_proxy api:3000 {
		header_up X-Forwarded-For {remote_host}
	}
	request_body {
		max_size 1MB
	}
	encode gzip
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```
`{remote_host}` is the immediate peer IP as Caddy (the TLS edge) sees it = the real client. This discards spoofed inbound XFF, so the app's per-IP throttle keys on the true source — closing the multi-account-spraying bypass that the app-side email-keying (SEC-3 part 1, already merged) does not cover.

**Acceptance:** config review confirms the directive. **Deploy-time verification (no automated test — Caddy is not in the Jest harness):** documented in the deploy runbook — against a deployed instance, send a request with a forged `X-Forwarded-For: 1.2.3.4` and confirm the app's rate-limit bucket / logged `traceId` source reflects the real client IP, not `1.2.3.4`.

## SEC-8 — activate CI (documentation only)

`.github/workflows/ci.yml` already defines three jobs on push/PR to `main`: `verify` (Prisma generate + typecheck + lint + unit + e2e w/ coverage), `audit` (`npm run audit:ci`, now `--audit-level=moderate` from the SEC-8 code fix), and `docker` (production image build). CI has simply never run because the repository has no git remote.

**Change:** add an **"Activating CI"** section to `docs/runbooks/deploy.md`: create a GitHub remote, push `main`, and CI (plus the previously-dormant WS1 quality gate) runs automatically; branch protection can then require the `verify` + `audit` checks. **No code.** This is an operator action; the spec records the exact steps so it is a one-command handoff.

## Delivery

- Commit 1: SEC-7 migration + e2e (the only one with a test).
- Commit 2: SEC-3 `Caddyfile` change + deploy-runbook verification note.
- Commit 3: SEC-8 runbook "Activating CI" note.
- Commit 4: mark SEC-3 (Caddy half), SEC-7, SEC-8 resolved/handed-off in `docs/production-readiness-audit-2026-06-17.md`.
- After the SEC-7 commit: `npm run typecheck`, relevant e2e; full unit + e2e suite before finishing. SEC-3/SEC-8 commits touch no TS (Caddyfile/markdown) — verified by review + the unchanged full suite.
- Fast-forward merge to `main` (no remote configured).

## Risks

- **SEC-7 migration application:** the trigger must apply cleanly in every e2e testcontainer (migrations run on boot). A syntax error fails the e2e clearly. The trigger function name is unqualified (`public` schema, matching the tables) — consistent with the DB the app uses.
- **SEC-7 over-broad block:** blocks ALL UPDATE/DELETE on `audit_log`, including legitimate future retention. Accepted (append-only is the point); escape hatch deferred.
- **SEC-3 unverified-here:** the Caddy↔Express XFF interaction is config-level and cannot be unit-tested in this repo; correctness rests on config review + the documented deploy-time check. If a future L4 load balancer is placed in front of Caddy, `{remote_host}` would be the LB and the directive would need `trusted_proxies` instead — noted in the runbook.
- **SEC-8 no-op-here:** nothing runs until an operator adds a remote and pushes; the spec/runbook makes that a single documented step, but it remains outside this repo's control.

## Out of scope

- A separate least-privilege DB app role (the two-role alternative to the SEC-7 trigger).
- Audit-log retention / purge tooling.
- Creating the GitHub remote or pushing (operator action).
- The other open audit backlog (offsite/encrypted backups, alert delivery, refresh-token already done) — separate §3/§4 items.
