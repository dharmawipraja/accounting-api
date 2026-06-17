# Security Infra Hardening (SEC-3 / SEC-7 / SEC-8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining §2 audit items — `audit_log` append-only (SEC-7, DB trigger), Caddy X-Forwarded-For overwrite (SEC-3), and CI activation (SEC-8) — recognizing only SEC-7 is automatically verifiable here.

**Architecture:** SEC-7 is a hand-authored SQL trigger migration with an e2e. SEC-3 is a one-block `Caddyfile` edit plus a deploy-runbook verification note (Caddy is not in the test harness). SEC-8 is a docs-only runbook section (the CI workflow already exists; it just needs an operator to add a git remote and push). No application-code change, no `schema.prisma` change, no new dependency.

**Tech Stack:** Postgres (hand-authored Prisma migrations, applied by the e2e testcontainer on boot), Caddy v2 reverse proxy, GitHub Actions (`.github/workflows/ci.yml`, already present), Jest e2e (`test/*.e2e-spec.ts`).

## Global Constraints

- No application-code (`src/**`) change, no `schema.prisma` change, no new dependency.
- Migrations are hand-authored SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`, mirroring existing migrations; the e2e testcontainer applies them on boot. Do NOT run `prisma migrate dev` (it would author a migration and flag the trigger as drift) — author the SQL by hand. No `prisma generate` needed (no schema change).
- The DB has a SINGLE role `accounting` that owns the tables; `audit_log` enforcement must therefore be a trigger (role-agnostic), NOT a `REVOKE`.
- `audit_log` writes are INSERT-only (`audit.service.ts` does `auditLog.create` + `findMany`); the trigger must block only UPDATE/DELETE, never INSERT/SELECT.
- E2E: `npm run test:e2e -- <pattern>`. After a code/migration task: `npm run typecheck` passes (unchanged; no TS edited in SEC-7) and the relevant e2e passes.
- Caddy is the TLS edge (clients connect directly); `{remote_host}` is the real client IP.
- Commit messages are conventional and end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `fix/security-infra-hardening` (already created, spec at `1b86902`).

## File Structure

- `prisma/migrations/20260617000001_audit_log_append_only/migration.sql` — NEW; the trigger (Task 1).
- `test/audit.e2e-spec.ts` — extend with the append-only test (Task 1).
- `Caddyfile` — XFF overwrite (Task 2).
- `docs/runbooks/deploy.md` — SEC-3 deploy-time verification note (Task 2) + SEC-8 "Activating CI" section (Task 3).
- `docs/production-readiness-audit-2026-06-17.md` — mark the three items resolved/handed-off (Task 4).

---

### Task 1: SEC-7 — `audit_log` append-only via DB trigger

**Files:**
- Create: `prisma/migrations/20260617000001_audit_log_append_only/migration.sql`
- Test: `test/audit.e2e-spec.ts` (add one test)

**Interfaces:**
- Produces: a Postgres trigger `audit_log_no_mutate` (function `audit_log_append_only()`) that raises on any UPDATE/DELETE of `audit_log`. No code interface; verified behaviorally.

- [ ] **Step 1: Write the failing test** — add to `test/audit.e2e-spec.ts`. First READ the file to match its bootstrap (testcontainer, `makePrismaOverride`, the prisma handle it uses — likely `prisma`/`prismaOverride` — and its `randomUUID` import; add the import if absent). Confirm the `AuditLog` model's required fields against `prisma/schema.prisma` (NOT NULL: `id`, `method`, `path`, `statusCode`, `durationMs`; `timestamp` defaults). Add:

```typescript
  it('SEC-7: audit_log is append-only — UPDATE and DELETE are rejected', async () => {
    const id = randomUUID();
    await prisma.client.auditLog.create({
      data: { id, method: 'GET', path: '/v1/probe', statusCode: 200, durationMs: 3 },
    });

    await expect(
      prisma.client.$executeRaw`UPDATE audit_log SET path = ${'/v1/tampered'} WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.client.$executeRaw`DELETE FROM audit_log WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/i);

    const row = await prisma.client.auditLog.findFirst({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.path).toBe('/v1/probe'); // unchanged by the rejected UPDATE
  });
```
(Use the same prisma handle name the file already uses. If the file uses `prismaOverride`, write `prismaOverride.client.…`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- audit`
Expected: FAIL — with no trigger yet, the `UPDATE` succeeds (resolves, does not throw), so `rejects.toThrow` fails (and the final `path` would be `/v1/tampered`).

- [ ] **Step 3: Write the trigger migration** — create `prisma/migrations/20260617000001_audit_log_append_only/migration.sql`:

```sql
-- Enforce append-only on audit_log at the database, independent of DB role
-- (the app/migrate role owns the table and would bypass any REVOKE). Blocks
-- UPDATE/DELETE for everyone; INSERT/SELECT are unaffected.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:e2e -- audit`
Expected: PASS — the testcontainer applies the new migration on boot; UPDATE and DELETE now reject with `audit_log is append-only: …`; the row is unchanged; the existing audit e2e tests (INSERT via the interceptor, ADMIN-gated read) stay green.

- [ ] **Step 5: Typecheck + commit** (no TS changed, but confirm the suite/types are clean)

```bash
npm run typecheck
git add prisma/migrations/20260617000001_audit_log_append_only/migration.sql test/audit.e2e-spec.ts
git commit -m "feat(audit): enforce audit_log append-only via DB trigger (SEC-7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SEC-3 — Caddy overwrites inbound X-Forwarded-For

**Files:**
- Modify: `Caddyfile`
- Modify: `docs/runbooks/deploy.md` (add a deploy-time verification note)

**Interfaces:** none (infra config + docs). No automated test — Caddy is not in the Jest harness; correctness rests on config review + the documented deploy-time check.

- [ ] **Step 1: Edit the `Caddyfile`** — replace the bare `reverse_proxy api:3000` line with a block that overwrites XFF with the real connecting client. The full file becomes:

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
(Keep the existing tabs/indentation style. Only the `reverse_proxy` line gains the block; everything else is unchanged.)

- [ ] **Step 2: Validate the Caddyfile formatting**

Run: `docker run --rm -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
Expected: `Valid configuration`. If Docker is unavailable in this environment, skip and note it — the directive is standard Caddy v2 syntax; the deploy will validate on `caddy` container start.

- [ ] **Step 3: Add the deploy-time verification note** — in `docs/runbooks/deploy.md`, add a new section after "## Health & shutdown":

```markdown
## Verifying the X-Forwarded-For overwrite (SEC-3)
Caddy is configured (`reverse_proxy { header_up X-Forwarded-For {remote_host} }`)
to overwrite any client-supplied `X-Forwarded-For` with the real connecting IP,
so the app's per-IP login throttle (`trust proxy: 1`) keys on the true source and
cannot be bypassed by a forged header. Verify against a deployed instance:
```bash
# Forge an XFF; the app must NOT trust it. Hammer the login limit from one real
# source with rotating forged XFFs — it should still 429 (keyed on the real IP),
# not mint a fresh bucket per forged value.
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" https://$DOMAIN/v1/auth/login \
    -H "X-Forwarded-For: 203.0.113.$i" -H 'Content-Type: application/json' \
    -d '{"email":"probe@example.com","password":"wrong"}'
done
# Expect the 11th/12th to be 429 (per-IP cap hit) — proving the forged XFF was ignored.
```
Note: this assumes Caddy is the TLS edge. If an L4 load balancer is ever placed in
front of Caddy, switch to the `trusted_proxies` directive so Caddy trusts the LB's
XFF instead of overwriting with the LB IP.
```

- [ ] **Step 4: Commit**

```bash
git add Caddyfile docs/runbooks/deploy.md
git commit -m "fix(caddy): overwrite spoofable X-Forwarded-For with real client IP (SEC-3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: SEC-8 — document CI activation

**Files:**
- Modify: `docs/runbooks/deploy.md` (add an "Activating CI" section)

**Interfaces:** none. `.github/workflows/ci.yml` already exists (jobs: `verify`, `audit` running `npm run audit:ci`, `docker`); this task only documents turning it on.

- [ ] **Step 1: Add the "Activating CI" section** — in `docs/runbooks/deploy.md`, append at the end:

```markdown
## Activating CI (SEC-8)
The CI workflow (`.github/workflows/ci.yml`) is committed but dormant — the repo
has no git remote, so nothing triggers it. To activate:
```bash
# 1. Create a GitHub repository, then add it as the remote:
git remote add origin git@github.com:<org>/accounting-api.git
# 2. Push main (this triggers CI on push):
git push -u origin main
```
On push/PR to `main`, CI runs three jobs: `verify` (Prisma generate + typecheck +
lint + unit + e2e with coverage), `audit` (`npm run audit:ci`, fails on a
moderate-or-higher advisory in prod deps), and `docker` (production image build).
Recommended next step: enable branch protection on `main` requiring the `verify`
and `audit` checks to pass before merge.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/deploy.md
git commit -m "docs(ci): document CI activation steps (SEC-8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full-suite verification + audit doc update

**Files:**
- Modify: `docs/production-readiness-audit-2026-06-17.md`

- [ ] **Step 1: Run the full unit + e2e suites**

```bash
npm test
npm run test:e2e
npm run typecheck
```
Expected: all unit suites pass; all e2e suites pass (the audit spec gains the append-only test; the new trigger migration applies in every testcontainer); typecheck clean. Report the actual totals and confirm 0 failures. If anything fails, STOP and report BLOCKED with the failing suite/test + a tight excerpt — do not edit the doc.

- [ ] **Step 2: Mark the items in `docs/production-readiness-audit-2026-06-17.md`** (§2):
  - **SEC-7** → "✅ FIXED (branch fix/security-infra-hardening) — append-only enforced via a `BEFORE UPDATE OR DELETE` trigger (`20260617000001_audit_log_append_only`); REVOKE would no-op against the single owner role."
  - **SEC-3** → note the Caddy infra half is now done: "✅ FIXED (Caddy `header_up X-Forwarded-For {remote_host}`); deploy-time verification in `docs/runbooks/deploy.md`."
  - **SEC-8** → "✅ Workflow + gate in place; activation is an operator step documented in `docs/runbooks/deploy.md` (add remote + push)."
  Match the doc's existing formatting; do not alter the original finding text.

- [ ] **Step 3: Commit**

```bash
git add docs/production-readiness-audit-2026-06-17.md
git commit -m "docs(audit): mark SEC-3 (Caddy)/SEC-7/SEC-8 resolved

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** every spec item maps to a task — SEC-7 trigger + e2e → T1; SEC-3 Caddyfile + deploy-verify note → T2; SEC-8 CI activation doc → T3; full-suite verify + audit-doc update → T4. The spec's "delivery: one commit per item + audit-doc update" is honored. Out-of-scope items (two-role DB alternative, retention tooling, creating the remote) are intentionally absent. No gaps.

**Placeholder scan:** no TBD/TODO. T1 Step 1 instructs reading `test/audit.e2e-spec.ts` for the exact prisma-handle name and confirming the `AuditLog` required fields against the schema rather than guessing — a concrete lookup, not a placeholder; all code/SQL/doc blocks are complete. T2 Step 2 has an explicit fallback if Docker is unavailable.

**Type/name consistency:** the migration object names (`audit_log_append_only` function, `audit_log_no_mutate` trigger) are used consistently in T1 and referenced verbatim in T4's audit-doc note. The error message `audit_log is append-only: …` matches the test's `/append-only/i` assertion. The migration timestamp `20260617000001` is strictly after the refresh-tokens migration `20260617000000` (correct apply order). `auditLog.create` fields (`id`, `method`, `path`, `statusCode`, `durationMs`) match the `AuditLog` model's `@map`ped non-null columns.

**Verifiability honesty:** T1 has a real RED→GREEN e2e; T2/T3 are config/docs with no automated test (explicit in each task and in Global Constraints), consistent with the spec's stated limit.
