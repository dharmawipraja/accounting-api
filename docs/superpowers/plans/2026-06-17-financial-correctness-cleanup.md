# Financial Correctness & Concurrency Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the remaining §1 (financial correctness & concurrency) findings from the production-readiness audit — all hardening/UX/consistency, no active money bugs.

**Architecture:** Seven independent, app-level fixes across the payments, balances, idempotency, tax-codes, and document-posting modules. Each is a self-contained test-first commit. No schema or migration changes.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`) + Postgres, `decimal.js` via the `Money` value object, Jest unit specs (`*.spec.ts` under `src/`, rootDir `src`), Jest e2e specs (`test/*.e2e-spec.ts`) against real Postgres via testcontainers.

## Global Constraints

- Node `>=22 <23`; no new runtime dependencies.
- All monetary math goes through `Money` (`src/common/money/money.ts`) — never JS floats.
- API base path is `/v1`; e2e HTTP calls use `/v1/...` with an `Idempotency-Key` header on money-movers.
- Domain errors map to HTTP via `AllExceptionsFilter`: `ValidationFailedError` → 422, `ConflictDomainError` → 409, `ClosedYearError` → 409.
- Unit tests: `npm test -- <pattern>`. E2E: `npm run test:e2e -- <pattern>`.
- Commit messages are conventional and end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch: `fix/financial-correctness-cleanup` (already created, spec committed at `ba89712`).
- After each task: `npm run typecheck` and `npx eslint <changed files> --max-warnings 0` must pass.

## File Structure

- `src/invoicing/payments.service.ts` — Tasks 1 (FIN-M1), 2 (FIN-M2), 3 (FIN-M3)
- `test/payments.e2e-spec.ts` — tests for Tasks 1–3 (reuses existing `makePostedInvoice`/`newCustomer` fixtures)
- `src/ledger/balances/balances.service.ts` — Task 4 (FIN-L1)
- `test/balances-soft-delete-filter.e2e-spec.ts` — new, Task 4
- `src/tax/tax-codes.service.ts` — Task 5 (FIN-M4)
- `src/tax/tax-codes.service.spec.ts` — new unit spec, Task 5
- `src/common/idempotency/idempotency.service.ts` + `src/config/env.validation.ts` — Task 6 (FIN-L2)
- `src/common/idempotency/idempotency.service.spec.ts` — extend, Task 6
- `src/invoicing/document-posting.service.ts` + `src/invoicing/sales-invoices.service.ts` + `src/invoicing/purchase-bills.service.ts` — Task 7 (NEW-1)

---

### Task 1: FIN-M1 — Cumulative draft payment validation

**Files:**
- Modify: `src/invoicing/payments.service.ts` (`createDraft`, ~133–163)
- Test: `test/payments.e2e-spec.ts` (add one `it`)

**Interfaces:**
- Consumes: existing `Money` (`add`, `subtract`, `isNegative`, `of`, `zero`), `loadTarget` (returns `{ id, partnerId, status, total, amountPaid }`).
- Produces: no new exports; behavior change only (422 at draft on cumulative over-allocation to the same document).

- [ ] **Step 1: Write the failing test** — add to `test/payments.e2e-spec.ts` (after the "rejects over-allocation" test, ~line 232):

```typescript
it('FIN-M1: rejects two allocations to the same invoice exceeding outstanding (422 at draft)', async () => {
  const customerId = await newCustomer('CUST-PAY-CUMUL');
  const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
  await request(server())
    .post('/v1/payments')
    .set('Authorization', `Bearer ${acct}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      direction: 'RECEIPT',
      partnerId: customerId,
      date: '2026-02-15',
      cashAccountId: acc['1-1000'],
      allocations: [
        { salesInvoiceId: invoiceId, amount: '600000' },
        { salesInvoiceId: invoiceId, amount: '600000' }, // 1,200,000 > 1,110,000
      ],
    })
    .expect(422);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: FAIL — this case returns **201** (both allocations pass draft validation independently), not 422.

- [ ] **Step 3: Write minimal implementation** — in `createDraft`, replace the allocation loop (the `let total = Money.zero();` block) with:

```typescript
    let total = Money.zero();
    const allocatedByDoc = new Map<string, Money>();
    for (const alloc of input.allocations) {
      const amt = Money.of(alloc.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError(
          'Allocation amount must be positive',
          {},
        );
      const target = await this.loadTarget(input.direction, alloc);
      if (target.partnerId !== input.partnerId)
        throw new ValidationFailedError(
          'Allocated document belongs to another partner',
          { documentId: target.id },
        );
      if (target.status !== 'POSTED')
        throw new ValidationFailedError(
          'Can only allocate to a POSTED document',
          { documentId: target.id, status: target.status },
        );
      // Outstanding net of what THIS payment already allocated to the same
      // document, so two allocations to one invoice can't each pass in isolation.
      const alreadyAllocated = allocatedByDoc.get(target.id) ?? Money.zero();
      const outstanding = Money.of(target.total.toString())
        .subtract(Money.of(target.amountPaid.toString()))
        .subtract(alreadyAllocated);
      // amt > outstanding  ⟺  (outstanding − amt) < 0
      if (outstanding.subtract(amt).isNegative()) {
        throw new ValidationFailedError(
          'Allocation exceeds the document outstanding',
          { documentId: target.id },
        );
      }
      allocatedByDoc.set(target.id, alreadyAllocated.add(amt));
      total = total.add(amt);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: PASS (all payments e2e green, including the new test).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/invoicing/payments.service.ts test/payments.e2e-spec.ts --max-warnings 0
git add src/invoicing/payments.service.ts test/payments.e2e-spec.ts
git commit -m "fix(payments): cumulative draft allocation validation (FIN-M1)

Two allocations to the same invoice each within outstanding both passed
draft validation; the over-allocation surfaced only as a late 409 at post
and stored an inflated payment.amount. Track per-document allocated amounts
within the payment and reject at draft time with a clean 422.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: FIN-M2 — Re-verify partner ownership at post time

**Files:**
- Modify: `src/invoicing/payments.service.ts` (`post`, the per-allocation `FOR UPDATE` selects, ~336–388)
- Test: `test/payments.e2e-spec.ts` (add one `it`)

**Interfaces:**
- Consumes: `payment.partnerId`, the locked-row select.
- Produces: post rejects (422) when a locked target document's `partner_id` ≠ the payment's partner.

- [ ] **Step 1: Write the failing test** — add to `test/payments.e2e-spec.ts`:

```typescript
it('FIN-M2: rejects post when the allocated document no longer belongs to the payment partner', async () => {
  const customerA = await newCustomer('CUST-OWNER-A');
  const customerB = await newCustomer('CUST-OWNER-B');
  const invoiceId = await makePostedInvoice(customerA);
  const draft = await request(server())
    .post('/v1/payments')
    .set('Authorization', `Bearer ${acct}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      direction: 'RECEIPT',
      partnerId: customerA,
      date: '2026-02-15',
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
    })
    .expect(201);
  const paymentId = (draft.body as { id: string }).id;
  // Manufacture the otherwise-impossible state: reassign the invoice to B.
  await prisma.client.salesInvoice.update({
    where: { id: invoiceId },
    data: { partnerId: customerB },
  });
  await request(server())
    .post(`/v1/payments/${paymentId}/post`)
    .set('Authorization', `Bearer ${appr}`)
    .set('Idempotency-Key', randomUUID())
    .expect(422);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: FAIL — post currently returns **200** (no partner re-check); test wants 422.

- [ ] **Step 3: Write minimal implementation** — in `post`, add `partner_id` to BOTH locked selects and compare. For the RECEIPT branch (sales invoice):

```typescript
            const rows = await tx.$queryRaw<
              {
                status: string;
                total: string;
                amount_paid: string;
                partner_id: string;
              }[]
            >`
            SELECT status, total, amount_paid, partner_id FROM sales_invoices WHERE id = ${a.salesInvoiceId} AND deleted_at IS NULL FOR UPDATE`;
            if (rows.length === 0 || rows[0].status !== 'POSTED')
              throw new ValidationFailedError(
                'Allocated invoice is not posted',
                { id: a.salesInvoiceId },
              );
            if (rows[0].partner_id !== payment.partnerId)
              throw new ValidationFailedError(
                'Allocated invoice belongs to another partner',
                { id: a.salesInvoiceId },
              );
```

For the DISBURSEMENT branch (purchase bill), mirror it:

```typescript
            const rows = await tx.$queryRaw<
              {
                status: string;
                total: string;
                amount_paid: string;
                partner_id: string;
              }[]
            >`
            SELECT status, total, amount_paid, partner_id FROM purchase_bills WHERE id = ${a.purchaseBillId} AND deleted_at IS NULL FOR UPDATE`;
            if (rows.length === 0 || rows[0].status !== 'POSTED')
              throw new ValidationFailedError('Allocated bill is not posted', {
                id: a.purchaseBillId,
              });
            if (rows[0].partner_id !== payment.partnerId)
              throw new ValidationFailedError(
                'Allocated bill belongs to another partner',
                { id: a.purchaseBillId },
              );
```

(Leave the existing outstanding computation and `increment` update lines unchanged below each block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/invoicing/payments.service.ts test/payments.e2e-spec.ts --max-warnings 0
git add src/invoicing/payments.service.ts test/payments.e2e-spec.ts
git commit -m "fix(payments): re-verify partner ownership under lock at post (FIN-M2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: FIN-M3 — Floor on void decrement

**Files:**
- Modify: `src/invoicing/payments.service.ts` (`void`, the decrement loop ~455–466)
- Test: `test/payments.e2e-spec.ts` (add one `it`)

**Interfaces:**
- Consumes: `Money`, `ConflictDomainError` (both already imported), the void transaction `tx`.
- Produces: void rejects (409) when decrementing would drive a target's `amount_paid` negative.

- [ ] **Step 1: Write the failing test** — add to `test/payments.e2e-spec.ts`:

```typescript
it('FIN-M3: void cannot drive amountPaid negative (conflict on underflow)', async () => {
  const customerId = await newCustomer('CUST-UNDERFLOW');
  const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
  const r = await request(server())
    .post('/v1/payments')
    .set('Authorization', `Bearer ${acct}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      direction: 'RECEIPT',
      partnerId: customerId,
      date: '2026-02-15',
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
    })
    .expect(201);
  const paymentId = (r.body as { id: string }).id;
  await request(server())
    .post(`/v1/payments/${paymentId}/post`)
    .set('Authorization', `Bearer ${appr}`)
    .set('Idempotency-Key', randomUUID())
    .expect(200);
  // Manufacture the otherwise-impossible state: amountPaid below the allocation.
  await prisma.client.salesInvoice.update({
    where: { id: invoiceId },
    data: { amountPaid: '500000' },
  });
  await request(server())
    .post(`/v1/payments/${paymentId}/void`)
    .set('Authorization', `Bearer ${appr}`)
    .set('Idempotency-Key', randomUUID())
    .expect(409);
  const inv = await prisma.client.salesInvoice.findFirst({
    where: { id: invoiceId },
  });
  expect(inv!.amountPaid.toString()).toBe('500000'); // unchanged; tx rolled back
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: FAIL — void currently decrements unconditionally (returns **200**, leaves `amountPaid` = -610000); test wants 409 and unchanged 500000.

- [ ] **Step 3: Write minimal implementation** — in `void`, replace the allocation decrement loop:

```typescript
        for (const a of allocations) {
          if (a.salesInvoiceId) {
            const rows = await tx.$queryRaw<{ amount_paid: string }[]>`
              SELECT amount_paid FROM sales_invoices WHERE id = ${a.salesInvoiceId} AND deleted_at IS NULL FOR UPDATE`;
            if (
              rows.length === 0 ||
              Money.of(rows[0].amount_paid)
                .subtract(Money.of(a.amount.toString()))
                .isNegative()
            )
              throw new ConflictDomainError(
                'Void would drive amountPaid negative',
                { id: a.salesInvoiceId },
              );
            await tx.salesInvoice.update({
              where: { id: a.salesInvoiceId },
              data: { amountPaid: { decrement: a.amount } },
            });
          }
          if (a.purchaseBillId) {
            const rows = await tx.$queryRaw<{ amount_paid: string }[]>`
              SELECT amount_paid FROM purchase_bills WHERE id = ${a.purchaseBillId} AND deleted_at IS NULL FOR UPDATE`;
            if (
              rows.length === 0 ||
              Money.of(rows[0].amount_paid)
                .subtract(Money.of(a.amount.toString()))
                .isNegative()
            )
              throw new ConflictDomainError(
                'Void would drive amountPaid negative',
                { id: a.purchaseBillId },
              );
            await tx.purchaseBill.update({
              where: { id: a.purchaseBillId },
              data: { amountPaid: { decrement: a.amount } },
            });
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- payments.e2e-spec`
Expected: PASS (including the existing "voiding a receipt restores invoice outstanding" test, which voids a correctly-paid invoice and is unaffected).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/invoicing/payments.service.ts test/payments.e2e-spec.ts --max-warnings 0
git add src/invoicing/payments.service.ts test/payments.e2e-spec.ts
git commit -m "fix(payments): floor amountPaid on void via locked re-check (FIN-M3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: FIN-L1 — Explicit soft-delete filter in balances

**Files:**
- Modify: `src/ledger/balances/balances.service.ts` (`groupedBalances` ~71–81, `accountBalance` ~163–169)
- Create: `test/balances-soft-delete-filter.e2e-spec.ts`

**Interfaces:**
- Consumes: `PostingService.post`, `BalancesService.accountBalance`.
- Produces: balances raw SQL excludes soft-deleted journal entries (`je.deleted_at IS NULL`).

- [ ] **Step 1: Write the failing test** — create `test/balances-soft-delete-filter.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Balances — soft-delete filter (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acc: Record<string, string>;
  let posting: PostingService;
  let balances: BalancesService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    balances = app.get(BalancesService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('excludes a soft-deleted POSTED journal entry from balances', async () => {
    const entry = await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100000' },
          { accountId: acc['4-1000'], credit: '100000' },
        ],
      },
      'p',
    );
    const before = await balances.accountBalance(
      acc['4-1000'],
      new Date('2026-12-31'),
    );
    expect(before.credit).toBe('100000.0000');
    // Manufacture the otherwise-impossible state: soft-delete a POSTED entry.
    await prisma.client.journalEntry.update({
      where: { id: entry.id },
      data: { deletedAt: new Date() },
    });
    const after = await balances.accountBalance(
      acc['4-1000'],
      new Date('2026-12-31'),
    );
    expect(after.credit).toBe('0.0000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- balances-soft-delete-filter`
Expected: FAIL — `after.credit` is still `100000.0000` (the raw SQL bypasses the soft-delete extension and does not filter `je.deleted_at`).

- [ ] **Step 3: Write minimal implementation** — in `groupedBalances`, change the `WHERE` line:

```typescript
      WHERE je.posted_at IS NOT NULL AND je.deleted_at IS NULL AND a.deleted_at IS NULL AND ${dateFilter}
```

And in `accountBalance`, change its `WHERE` line:

```typescript
      WHERE jl.account_id = ${accountId} AND je.posted_at IS NOT NULL AND je.deleted_at IS NULL AND je.date <= ${day}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- balances-soft-delete-filter`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/ledger/balances/balances.service.ts test/balances-soft-delete-filter.e2e-spec.ts --max-warnings 0
git add src/ledger/balances/balances.service.ts test/balances-soft-delete-filter.e2e-spec.ts
git commit -m "fix(balances): exclude soft-deleted journal entries in raw SQL (FIN-L1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: FIN-M4 — Principled tax-rate validation

**Files:**
- Modify: `src/tax/tax-codes.service.ts` (`validateRate` ~41–49; add `Decimal` import)
- Create: `src/tax/tax-codes.service.spec.ts`

**Interfaces:**
- Consumes: `Decimal` from `decimal.js`, `ValidationFailedError`.
- Produces: `validateRate` rejects rates ∉ (0,1), non-decimal strings, and rates with `> 6` decimal places.

- [ ] **Step 1: Write the failing test** — create `src/tax/tax-codes.service.spec.ts`:

```typescript
import { TaxCodesService } from './tax-codes.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountsService } from '../ledger/accounts/accounts.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

// validateRate runs first in create(), before any dependency is touched, so we
// can pass undefined deps and assert purely on rate validation.
function makeService(): TaxCodesService {
  return new TaxCodesService(
    undefined as unknown as PrismaService,
    undefined as unknown as AccountsService,
  );
}
const base = {
  code: 'X',
  name: 'X',
  kind: 'PPN_OUTPUT' as const,
  taxAccountId: 'acct',
};

describe('TaxCodesService.validateRate (via create)', () => {
  it('rejects a rate with more than 6 decimal places', async () => {
    await expect(
      makeService().create({ ...base, rate: '0.1234567' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a rate of 0 or >= 1', async () => {
    await expect(
      makeService().create({ ...base, rate: '0' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      makeService().create({ ...base, rate: '1' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      makeService().create({ ...base, rate: '1.5' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tax-codes.service`
Expected: FAIL — the "more than 6 decimal places" case currently passes `validateRate` (float `0.1234567` is in (0,1)), so `create()` proceeds to call the undefined `accounts` dependency and rejects with a `TypeError`, not `ValidationFailedError`. (The 0/≥1 case already passes.)

- [ ] **Step 3: Write minimal implementation** — add the import at the top of `src/tax/tax-codes.service.ts`:

```typescript
import { Decimal } from 'decimal.js';
```

Replace `validateRate`:

```typescript
  private validateRate(rate: string): void {
    let r: Decimal;
    try {
      r = new Decimal(rate);
    } catch {
      throw new ValidationFailedError('Rate must be a valid decimal', { rate });
    }
    if (!(r.greaterThan(0) && r.lessThan(1))) {
      throw new ValidationFailedError(
        'Rate must be greater than 0 and less than 1',
        { rate },
      );
    }
    if (r.decimalPlaces() > 6) {
      throw new ValidationFailedError(
        'Rate must have at most 6 decimal places',
        { rate },
      );
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tax-codes.service`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/tax/tax-codes.service.ts src/tax/tax-codes.service.spec.ts --max-warnings 0
git add src/tax/tax-codes.service.ts src/tax/tax-codes.service.spec.ts
git commit -m "fix(tax): Decimal-based rate validation incl. precision (FIN-M4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: FIN-L2 — Lazy expiry of stale in-flight idempotency keys

**Files:**
- Modify: `src/common/idempotency/idempotency.service.ts` (inject `ConfigService`; add reclaim path)
- Modify: `src/config/env.validation.ts` (add optional `IDEMPOTENCY_INFLIGHT_TTL_MS`)
- Modify: `src/common/idempotency/idempotency.service.spec.ts` (extend `makeService`; two new tests)

**Interfaces:**
- Consumes: `ConfigService` (globally available — `PrismaService` already injects it), `IdempotencyKey.createdAt` (Prisma `@default(now())`), `idempotencyKey.deleteMany`.
- Produces: `reserve()` signature unchanged; a stale in-flight reservation (older than `IDEMPOTENCY_INFLIGHT_TTL_MS`, default 120000) is reclaimed once so the retry proceeds. Genuinely-running and completed keys behave as before.

- [ ] **Step 1: Write the failing test** — first extend `makeService` in `src/common/idempotency/idempotency.service.spec.ts` to add the `deleteMany` mock and a `ConfigService` stub, then add two tests. Replace the existing `makeService`:

```typescript
import { ConfigService } from '@nestjs/config';
// ...existing imports...

function makeService(ttlMs?: number) {
  const idempotencyKey = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
  const config = { get: () => ttlMs } as unknown as ConfigService;
  return { service: new IdempotencyService(prisma, config), idempotencyKey };
}
```

Add these tests inside the `describe`:

```typescript
  it('reclaims a stale in-flight key and re-reserves it', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create
      .mockRejectedValueOnce(P2002) // first attempt: row exists
      .mockResolvedValueOnce({}); // after reclaim: fresh insert succeeds
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      createdAt: new Date('2000-01-01'), // far older than the TTL
    });
    idempotencyKey.deleteMany.mockResolvedValue({ count: 1 });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: false });
    expect(idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it('keeps a fresh in-flight key as 409 (not reclaimed)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      createdAt: new Date(), // fresh
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- idempotency.service`
Expected: FAIL — the "reclaims a stale in-flight key" test rejects with `ConflictDomainError` (current code has no reclaim path), so `resolves.toEqual({ replay: false })` fails. (Compilation also fails until the constructor takes `ConfigService` — that is part of the RED for this task.)

- [ ] **Step 3: Write minimal implementation** — rewrite `src/common/idempotency/idempotency.service.ts` `reserve`/`resolveExisting` (keep `complete`/`release` unchanged), adding the `ConfigService` import and constructor param:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../errors/domain-errors';

// ...ReserveResult + class JSDoc unchanged...

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get inflightTtlMs(): number {
    return this.config.get<number>('IDEMPOTENCY_INFLIGHT_TTL_MS') ?? 120_000;
  }

  async reserve(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    return this.reserveOnce(key, method, path, requestHash, true);
  }

  private async reserveOnce(
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    try {
      await this.prisma.client.idempotencyKey.create({
        data: { key, method, path, requestHash },
      });
      return { replay: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.resolveExisting(
          key,
          method,
          path,
          requestHash,
          allowReclaim,
        );
      }
      throw err;
    }
  }

  private async resolveExisting(
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    const record = await this.prisma.client.idempotencyKey.findUnique({
      where: { key },
    });
    if (!record) {
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    if (record.method !== method || record.path !== path) {
      throw new ValidationFailedError(
        'Idempotency-Key already used for a different endpoint',
        { key },
      );
    }
    if (record.requestHash !== requestHash) {
      throw new ValidationFailedError(
        'Idempotency-Key already used with a different request body',
        { key },
      );
    }
    if (record.response === null || record.httpStatus === null) {
      // In-flight. If the reservation is older than the TTL, the owner crashed
      // between its commit and complete(); reclaim it once so this retry can
      // proceed. The atomic deleteMany ensures only one racing retry wins.
      if (allowReclaim && this.isStale(record.createdAt)) {
        const cleared = await this.prisma.client.idempotencyKey.deleteMany({
          where: {
            key,
            response: null,
            completedAt: null,
            createdAt: { lt: new Date(Date.now() - this.inflightTtlMs) },
          },
        });
        if (cleared.count > 0) {
          return this.reserveOnce(key, method, path, requestHash, false);
        }
      }
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    return {
      replay: true,
      response: record.response,
      httpStatus: record.httpStatus,
    };
  }

  private isStale(createdAt: Date | null | undefined): boolean {
    if (!createdAt) return false;
    return Date.now() - new Date(createdAt).getTime() > this.inflightTtlMs;
  }

  // complete() and release() remain exactly as they are.
```

Then add the env var to `src/config/env.validation.ts` (after `DB_STATEMENT_TIMEOUT_MS`):

```typescript
  @IsOptional()
  @IsInt()
  @Min(1000)
  IDEMPOTENCY_INFLIGHT_TTL_MS?: number;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- idempotency.service`
Expected: PASS — all 10 tests (8 existing + 2 new). The existing "in-progress 409" test still 409s (its row has no `createdAt`, so `isStale` returns false).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/common/idempotency/idempotency.service.ts src/common/idempotency/idempotency.service.spec.ts src/config/env.validation.ts --max-warnings 0
git add src/common/idempotency/idempotency.service.ts src/common/idempotency/idempotency.service.spec.ts src/config/env.validation.ts
git commit -m "fix(idempotency): reclaim stale in-flight keys via lazy expiry (FIN-L2)

A crash between the handler commit and complete() left a key stuck
response=null forever, 409-ing every retry. On a retry, if the in-flight
reservation is older than IDEMPOTENCY_INFLIGHT_TTL_MS (default 120s, well
above max handler time), atomically reclaim it and re-reserve once.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: NEW-1 — Single tax computation per document post

**Files:**
- Modify: `src/invoicing/document-posting.service.ts` (add `summarize`; extend `PostedDocContext`; reuse `calc` in `post`)
- Modify: `src/invoicing/sales-invoices.service.ts` (`post` finalize callback ~316–338)
- Modify: `src/invoicing/purchase-bills.service.ts` (`post` finalize callback ~320–341)

**Interfaces:**
- Consumes: `TaxCalculation` (from `../tax/tax.service`), the existing `calc` computed in `DocumentPostingService.post`.
- Produces: `PostedDocContext` gains `totals: { subtotal: string; taxTotal: string; withholdingTotal: string; total: string }`; `computeTotals` behavior unchanged (still used by draft preview). This is a **pure refactor** — same stored totals and journal as before, with `tax.calculate` invoked once per post.

- [ ] **Step 1: Confirm the safety-net tests are green first** (this is a refactor — existing e2e are the test)

Run: `npm run test:e2e -- "sales-invoices.e2e-spec" && npm run test:e2e -- "purchase-bills.e2e-spec"`
Expected: PASS (baseline). These assert stored `subtotal/taxTotal/withholdingTotal/total` equal the posted journal — the invariant the refactor must preserve.

- [ ] **Step 2: Refactor `DocumentPostingService`** — in `src/invoicing/document-posting.service.ts`:

Add `TaxCalculation` to the tax import:

```typescript
import { TaxService, TaxableLineInput, TaxCalculation } from '../tax/tax.service';
```

Add `totals` to `PostedDocContext`:

```typescript
export interface PostedDocContext {
  tx: LedgerTx;
  number: number;
  ref: string;
  entry: JournalEntry;
  fiscalYear: number;
  totals: {
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  };
}
```

Add a private `summarize` and route `computeTotals` through it:

```typescript
  /** Split a tax calculation into the stored document totals. */
  private summarize(calc: TaxCalculation): {
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  } {
    let taxTotal = Money.zero();
    let withholdingTotal = Money.zero();
    for (const t of calc.taxes) {
      if (t.kind === 'PPN_OUTPUT' || t.kind === 'PPN_INPUT')
        taxTotal = taxTotal.add(Money.of(t.amount));
      else withholdingTotal = withholdingTotal.add(Money.of(t.amount));
    }
    return {
      subtotal: calc.subtotal,
      taxTotal: taxTotal.toPersistence(),
      withholdingTotal: withholdingTotal.toPersistence(),
      total: calc.settlementAmount,
    };
  }

  async computeTotals(
    nature: 'SALE' | 'PURCHASE',
    settlementAccountId: string,
    lines: TaxableLineInput[],
  ): Promise<{
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  }> {
    const calc = await this.tax.calculate({
      nature,
      settlementAccountId,
      lines,
    });
    return this.summarize(calc);
  }
```

In `post`, pass the totals computed from the `calc` it already has into `finalize`:

```typescript
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        journalInput,
        params.postedBy,
        periodId,
        fiscalYear,
      );
      await finalize({
        tx,
        number,
        ref,
        entry,
        fiscalYear,
        totals: this.summarize(calc),
      });
```

- [ ] **Step 3: Update the finalize callbacks** — in `src/invoicing/sales-invoices.service.ts` `post`, replace the finalize callback body so it uses `totals` from the context instead of calling `computeTotals` again:

```typescript
      async ({ tx, number, ref, entry, fiscalYear, totals }) => {
        await tx.salesInvoice.update({
          where: { id },
          data: {
            status: 'POSTED',
            invoiceNumber: number,
            invoiceRef: ref,
            fiscalYear,
            journalEntryId: entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            withholdingTotal: totals.withholdingTotal,
            total: totals.total,
          },
        });
      },
```

In `src/invoicing/purchase-bills.service.ts` `post`, the same shape:

```typescript
      async ({ tx, number, ref, entry, fiscalYear, totals }) => {
        await tx.purchaseBill.update({
          where: { id },
          data: {
            status: 'POSTED',
            billNumber: number,
            billRef: ref,
            fiscalYear,
            journalEntryId: entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            withholdingTotal: totals.withholdingTotal,
            total: totals.total,
          },
        });
      },
```

- [ ] **Step 4: Run the safety-net tests to verify they still pass**

Run: `npm run test:e2e -- "sales-invoices.e2e-spec" && npm run test:e2e -- "purchase-bills.e2e-spec"`
Expected: PASS — identical stored totals/journal; `tax.calculate` now runs once per post.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/invoicing/document-posting.service.ts src/invoicing/sales-invoices.service.ts src/invoicing/purchase-bills.service.ts --max-warnings 0
git add src/invoicing/document-posting.service.ts src/invoicing/sales-invoices.service.ts src/invoicing/purchase-bills.service.ts
git commit -m "refactor(invoicing): compute tax once per document post (NEW-1)

post() reused the calc it already had to build the journal lines, but the
finalize callback called computeTotals — a second tax.calculate — to store
the document totals. Pass the summarized totals through PostedDocContext so
one calculation feeds both the journal and the stored totals.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full-suite verification + audit doc update

**Files:**
- Modify: `docs/production-readiness-audit-2026-06-17.md` (mark the seven items fixed)

- [ ] **Step 1: Run the full unit + e2e suites**

```bash
npm test
npm run test:e2e
```
Expected: all unit suites pass; all e2e suites pass (180 prior + the new balances spec; the payments spec gains 3 tests). No regressions.

- [ ] **Step 2: Mark the items fixed** in `docs/production-readiness-audit-2026-06-17.md` — add a short "✅ FIXED" note to each of FIN-M1, FIN-M2, FIN-M3, FIN-M4, FIN-L1, FIN-L2 (in §1) and NEW-1 (in the Verification log appendix), referencing this branch.

- [ ] **Step 3: Commit**

```bash
git add docs/production-readiness-audit-2026-06-17.md
git commit -m "docs(audit): mark remaining §1 items (FIN-M1..L2, NEW-1) fixed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** every spec item maps to a task — FIN-M1→T1, FIN-M2→T2, FIN-M3→T3, FIN-L1→T4, FIN-M4→T5, FIN-L2→T6, NEW-1→T7, plus T8 for the spec's "full suite + audit doc update" delivery step. No gaps.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every test step shows the full test; commands have expected outcomes.

**Type consistency:** `PostedDocContext.totals` (T7) matches the object `summarize` returns and the fields the finalize callbacks read; `reserveOnce`/`resolveExisting` carry the `allowReclaim: boolean` param consistently (T6); `makeService(ttlMs?)` + `deleteMany` mock match the new constructor (`PrismaService`, `ConfigService`) in T6; `validateRate` uses `Decimal` imported in T5.

**Note on TDD for defensive items (T2, T3, T4):** these guard conditions that cannot occur through normal app flow, so their tests manufacture the impossible state via direct Prisma writes; each still fails RED against current code (no guard) and passes after — verify the RED in Step 2 of each before implementing.
