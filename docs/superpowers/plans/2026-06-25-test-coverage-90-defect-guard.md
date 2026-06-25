# Test Coverage to 90% as a Defect Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the test suites a real defect guard by gating MERGED (unit ∪ e2e) coverage at 90% global, closing the genuine integration-service branch gaps with behavior-asserting tests — no line-coloring, no duplicate tests.

**Architecture:** Both jest suites emit JSON coverage; `nyc` merges them into one report; `nyc check-coverage` enforces the merged thresholds inside `npm run verify`. A branch covered by *either* suite counts. New tests target real uncovered branches in the integration services (validation/guard error paths); pure modules stay unit-covered.

**Tech Stack:** NestJS 11, Jest 30 + ts-jest, supertest, testcontainers (e2e, real Postgres), `nyc` (Istanbul) for the merge + gate, `bootstrapTestApp()` e2e harness.

## Global Constraints

- Branch: `test/coverage-90-guard` (already created, off `main` at the v1.1.0 release).
- The gate is the **MERGED** report (`nyc check-coverage`), NOT either suite's global threshold. Per-suite `coverageThreshold` floors stay only as fast anti-regression gates — do not raise either to 90.
- **Ratchet-to-meaningful:** aim 90 for statements/functions/lines; branches = honest achieved (≥ current merged, target 90). Never write a test solely to cover a defensive/unreachable branch (`?? fallback`, rethrow, framework edge, `@Cron`-only purge body) — leave it, and record it in the gap-analysis (b)-list.
- **Quality bar (every test):** assert observable behavior (HTTP status + body, or function return/throw) — never internal calls / mock-interaction counts. No mocking Prisma/JWT to fake-unit-test integration code. Each test carries a one-line note of the failure mode it guards. e2e specs use `bootstrapTestApp()`; pure unit specs follow `src/reporting/income-statement.service.spec.ts`.
- **Guardrail:** do NOT extract logic out of integration services (`year-end-close`, `auth`, `refresh-token`, interceptors, guards) to make it unit-testable. Those stay e2e-guarded.
- Spec: `docs/superpowers/specs/2026-06-25-test-coverage-90-defect-guard-design.md`.
- Measured baseline (before this work): unit 31.2/29.8/27.3/30.5; e2e 89.1/71.1/90.4/89.6 (stmts/branch/funcs/lines).

---

### Task 1: Coverage-merge tooling + baseline ratchet

**Files:**
- Modify: `package.json` (devDependency `nyc`; scripts `coverage:merge`, `test:cov:all`, `verify`; unit `jest.collectCoverageFrom` add scripts exclusion)
- Modify: `test/jest-e2e.json` (`collectCoverageFrom` add scripts exclusion)
- Create: `.nycrc.json` (merged thresholds + report config)
- Modify: `.gitignore` (ignore `.nyc_output/`, `coverage-merged/`)

**Interfaces:**
- Produces: `npm run test:cov:all` (runs unit-cov + e2e-cov + merge + `nyc check-coverage`); `.nycrc.json` thresholds = the ratchet floor (later tasks raise it).

- [ ] **Step 1: Add nyc**

```bash
npm install -D nyc
```

- [ ] **Step 2: Exclude the build script from coverage**

In `package.json` `jest.collectCoverageFrom`, add `"!**/scripts/**"`. In `test/jest-e2e.json` `collectCoverageFrom`, add `"!<rootDir>/src/scripts/**"`. (`export-openapi.ts` is a build script, not runtime code.)

- [ ] **Step 3: Add `.nycrc.json`** (thresholds are placeholders set in Step 6)

```json
{
  "temp-dir": ".nyc_output",
  "report-dir": "coverage-merged",
  "reporter": ["text-summary", "html"],
  "check-coverage": true,
  "statements": 0,
  "branches": 0,
  "functions": 0,
  "lines": 0
}
```

- [ ] **Step 4: Add scripts to `package.json`**

```jsonc
"coverage:merge": "rm -rf .nyc_output coverage-merged && mkdir -p .nyc_output && cp coverage/coverage-final.json .nyc_output/unit.json && cp coverage-e2e/coverage-final.json .nyc_output/e2e.json && nyc report && nyc check-coverage",
"test:cov:all": "npm run test:cov && npm run test:e2e:cov && npm run coverage:merge",
```

Change `verify` to: `"npm run typecheck && npm run lint:ci && npm run test:cov:all"`.

- [ ] **Step 5: Add to `.gitignore`**

```
.nyc_output/
coverage-merged/
```

- [ ] **Step 6: Run the pipeline, read the MERGED numbers, set the baseline floor**

Run: `npm run test:cov:all`
Expected: text-summary prints a merged report. **Verify the merge actually combined** (merged branch % must be HIGHER than e2e-alone 71.1 — because unit fills the pure modules; if it equals 71.1, the json paths didn't align — both `coverage-final.json` use absolute paths and must, so investigate). Record the merged statements/branches/functions/lines.
Set `.nycrc.json` thresholds to `Math.floor` of each merged metric (the ratchet baseline — locks in current state). `nyc check-coverage` must now pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json test/jest-e2e.json .nycrc.json .gitignore
git commit -m "test(cov): merged unit+e2e coverage gate via nyc (baseline ratchet)"
```

---

### Task 2: Gap-analysis backlog artifact

**Files:**
- Create: `docs/superpowers/plans/2026-06-25-coverage-gap-analysis.md`

**Interfaces:**
- Produces: the categorized (a)/(b) backlog that Tasks 3–5 implement. Group (a) rows by module area.

- [ ] **Step 1: Generate the per-file uncovered report**

Run: `npm run test:e2e:cov` (already passes). From `coverage-e2e/coverage-final.json` (or the text table), list every integration file with branch < 90 and its uncovered branch lines. Known hotspots: `taxed-document.service` (112-151,208,211,247,252,262), `purchase-bills.service` (89-90,130-133,145), `payments.service` (58,64,69,76,91,96,194-209,220,259,306), `business-partners.service` (62,118-130), `payment-targets` (165,176,182,207), `posting.service` (256-264,283,293,384,386,405,414,488,497), `journal.service` (88,105,146,199,201,203), `periods.service` (84,86,100), `accounts.service` (68,91-97,178,206-217,239), `document-lifecycle.service` (37,74,86), `tax-codes.service` (49,58,71,107,144-154,180,196-202), `year-end-close.service` (73,103,180,196,207), `closing.controller` (37,48,56-61), `aging.service` (32-33).

- [ ] **Step 2: Read each uncovered branch and categorize**

For each uncovered line, read the source and classify:
- **(a) real behavior** — record: file, line, the guard/condition, the failure mode, and the expected HTTP status (or function outcome). Example (already verified): `payments.service:57` `allocations.length === 0 → 422`; `:64` `!partner.isActive → 422`; `:69` partner-not-customer/supplier `→ 422`; `:76` cash-not-postable `→ 422`; `:91` non-positive allocation `→ 422`; `taxed-document.service:114` edit non-`DRAFT` `→ 422`; `tax-codes.service:49` invalid rate `→ 422`, `:58` rate not in (0,1) `→ 422`, `:71` `>6dp → 422`, account-not-postable `→ 422`.
- **(b) defensive/unreachable** — record file, line, one-line reason (e.g. `?? fallback never null in practice`, `rethrow of already-typed error`, `@Cron purge body — time-driven, not request-reachable`). These stay uncovered.

- [ ] **Step 3: Write the artifact** as a table per module area (invoicing / ledger / tax / close / reporting), (a) rows = the test backlog, (b) rows = documented exclusions. No code — this is the spec for Tasks 3–5.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-25-coverage-gap-analysis.md
git commit -m "test(cov): gap-analysis backlog (categorized uncovered branches)"
```

---

### Task 3: E2E batch — invoicing services

**Files:**
- Modify: `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/business-partners.e2e-spec.ts` (add the (a) cases for `taxed-document.service`, `purchase-bills.service`, `payments.service`, `business-partners.service`, `payment-targets`)

**Interfaces:**
- Consumes: the (a) rows for the invoicing area from Task 2's artifact; `bootstrapTestApp()` and the seed/login helpers already used in each existing spec.
- Produces: covered branches in the invoicing services.

- [ ] **Step 1: Write the failing tests for the invoicing (a)-rows**

Mirror the existing spec's setup (same `bootstrapTestApp()`, seeding, and auth-token helpers already in that file). One fully-worked example (payments, empty-allocations guard, `payments.service:57`):

```ts
it('rejects a payment with no allocations → 422 (allocations.length === 0)', async () => {
  // seed partner + cash account exactly as the existing "posts a receipt" test does
  const res = await request(app.getHttpServer())
    .post('/v1/payments')
    .set('Authorization', `Bearer ${accountantToken}`)
    .set('Idempotency-Key', 'pay-empty-alloc')
    .send({ direction: 'RECEIPT', partnerId, date: '2026-01-15', cashAccountId, allocations: [] });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('VALIDATION_FAILED');
});
```

Add one test per (a)-row for this area (partner-inactive 422, partner-not-customer/supplier 422, cash-not-postable 422, non-positive allocation 422, edit-non-DRAFT 422, etc.), each asserting status + `body.code`, each with a one-line failure-mode comment.

- [ ] **Step 2: Run to verify they fail/pass correctly**

Run: `npm run test:e2e -- sales-invoices purchase-bills payments business-partners`
Expected: the new tests PASS (the guards already exist — these are characterization tests that lock in the behavior). For any that unexpectedly DON'T hit 422, read the guard and fix the test's setup (do not change app code).

- [ ] **Step 3: Confirm the targeted branches are now covered**

Run: `npm run test:e2e:cov` and check the four invoicing files' branch % rose toward 90 for the targeted lines.

- [ ] **Step 4: Commit**

```bash
git add test/sales-invoices.e2e-spec.ts test/purchase-bills.e2e-spec.ts test/payments.e2e-spec.ts test/business-partners.e2e-spec.ts
git commit -m "test(e2e): cover invoicing-service guard branches (validation 422s)"
```

---

### Task 4: E2E batch — ledger & close

**Files:**
- Modify: `test/posting.e2e-spec.ts`, `test/journal.e2e-spec.ts`, `test/periods.e2e-spec.ts`, `test/accounts.e2e-spec.ts`, `test/close.e2e-spec.ts`, `test/close-out-of-order.e2e-spec.ts`, `test/close-reversal-guard.e2e-spec.ts` (add the (a) cases for `posting.service`, `journal.service`, `periods.service`, `accounts.service`, `year-end-close.service`, `closing.controller`). `document-lifecycle.service` branches (softDeleteDraft / reverseWithGuard) are reached via the delete-draft + reverse cases in these and the Task-3 invoicing specs — no dedicated spec.

**Interfaces:**
- Consumes: the (a) rows for ledger + close from Task 2; existing spec helpers.
- Produces: covered guard branches in ledger/close.

- [ ] **Step 1: Write the failing tests for the ledger/close (a)-rows**

One worked example (close into already-closed / out-of-order, or `closing.controller` role/validation branch). For each (a)-row add a behavior test (e.g. post into a closed period → 422; reverse an already-reversed entry → 422; close a year out of order → guard; non-APPROVER hits `closing.controller` → 403). Mirror the existing close/posting spec setup. Assert status + `body.code`.

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- posting journal periods accounts close`
Expected: new tests pass; fix test setup (not app code) for any miss.

- [ ] **Step 3: Confirm branch coverage rose for these files** (`npm run test:e2e:cov`).

- [ ] **Step 4: Commit**

```bash
git add test/posting.e2e-spec.ts test/journal.e2e-spec.ts test/periods.e2e-spec.ts test/accounts.e2e-spec.ts test/close.e2e-spec.ts test/close-out-of-order.e2e-spec.ts test/close-reversal-guard.e2e-spec.ts
git commit -m "test(e2e): cover ledger + year-end-close guard branches"
```

---

### Task 5: E2E batch — tax-codes & reporting

**Files:**
- Modify: `test/tax-codes.e2e-spec.ts` (or the tax spec), `test/reporting-aging.e2e-spec.ts` (add the (a) cases for `tax-codes.service` and `aging.service`)

**Interfaces:**
- Consumes: the (a) rows for tax + reporting from Task 2.

- [ ] **Step 1: Write the failing tests**

tax-codes (a)-rows: rate-not-a-decimal → 422, rate not in (0,1) → 422, rate `>6dp` → 422, tax account not postable → 422, duplicate code → 409, deactivate/guard paths. aging (a)-rows: the `bucketOf` boundary branch at `aging.service:32-33` (a document landing in the next bucket as-of a date — extend the existing aging assertions). Mirror existing spec setup; assert status + body.

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- tax-codes reporting-aging`
Expected: pass.

- [ ] **Step 3: Confirm branch coverage rose** (`npm run test:e2e:cov`).

- [ ] **Step 4: Commit**

```bash
git add test/tax-codes.e2e-spec.ts test/reporting-aging.e2e-spec.ts
git commit -m "test(e2e): cover tax-code validation + aging-bucket branches"
```

---

### Task 6: Unit gap-fill (Workstream 2)

**Files:**
- Create: `src/common/dates/parse-date.spec.ts`
- Modify (only if the merged gate still shows a gap): the existing spec for any pure module whose unit branch < 90 (e.g. `all-exceptions.filter.spec.ts`), adding only genuinely-reachable branch cases.

**Interfaces:**
- Consumes: `parseDate` from `src/common/dates/parse-date.ts`.

- [ ] **Step 1: Write `parse-date.spec.ts`**

```ts
import { parseDate } from './parse-date';

describe('parseDate', () => {
  it('returns undefined for undefined/empty input', () => {
    expect(parseDate(undefined)).toBeUndefined();
    expect(parseDate('')).toBeUndefined();
  });
  it('parses an ISO date string to a Date', () => {
    const d = parseDate('2026-01-15');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-01-15');
  });
});
```

(Adjust the empty-string expectation to match `parse-date.ts`'s actual contract — read it first; the spec must assert the real behavior, not assume it.)

- [ ] **Step 2: Run** — `npm run test:cov -- parse-date` — Expected: PASS, `parse-date.ts` at/near 100%.

- [ ] **Step 3: Close any remaining pure-module branch gap** the merged report flags (only reachable branches; defensive ones go to the (b)-list, not a test).

- [ ] **Step 4: Commit**

```bash
git add src/common/dates/parse-date.spec.ts
git commit -m "test(unit): cover parseDate (+ pure-module branch gap-fill)"
```

---

### Task 7: Ratchet the merged thresholds + document the policy

**Files:**
- Modify: `.nycrc.json` (raise thresholds to achieved)
- Modify: `docs/runbooks/testing.md`, `docs/runbooks/conventions.md` (document the merged-coverage policy + the (b)-exclusion reference)

**Interfaces:**
- Consumes: the final merged numbers after Tasks 3–6.

- [ ] **Step 1: Run the full merged pipeline** — `npm run test:cov:all` — record the achieved merged statements/branches/functions/lines.

- [ ] **Step 2: Set `.nycrc.json` thresholds** to: statements/functions/lines = 90 (must be ≤ achieved — if any sits at 89.x, drive it with a remaining (a)-row or set that metric to its achieved floor and note why); branches = the achieved floor (target 90; never below 71). These are the ratcheted gates.

- [ ] **Step 3: Document the policy**

In `docs/runbooks/testing.md`: the gate is merged unit∪e2e via `npm run test:cov:all` / `nyc check-coverage`; per-suite floors are fast anti-regression only; pure modules are unit-guarded, integration via e2e; branches are ratchet-to-meaningful with documented (b)-exclusions (link the gap-analysis artifact). In `conventions.md`: add the quality-bar checklist (behavior not implementation; no Prisma/JWT mock-theater; every test names its failure mode).

- [ ] **Step 4: Full verify** — `npm run verify` — Expected: green, merged `check-coverage` passes at the ratcheted thresholds.

- [ ] **Step 5: Commit**

```bash
git add .nycrc.json docs/runbooks/testing.md docs/runbooks/conventions.md
git commit -m "test(cov): ratchet merged thresholds to 90 (branches honest-achieved) + document policy"
```

---

## Notes for the executor

- Tasks 3–5 are **characterization tests on existing guards** — they should pass on first write (the guards already exist; we're locking in their behavior). If a "failing test" step passes immediately, that is expected here; the RED you care about is a regression later. If a test does NOT produce the expected status, the bug is in the test's setup — fix the test, never the app code, unless Task 2 flagged a genuine defect (escalate that separately).
- After each e2e batch, the merged branch number should climb. If a targeted branch stays uncovered after a test that should hit it, the branch may be (b) (unreachable) — move it to the exclusion list rather than contorting a test.
- Keep batches small enough to review; if an area's (a)-list is large, split its task by file.
