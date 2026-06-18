# Audit Remnants Implementation Plan (OPS-RES-2 + OPS-CFG-3 + OPS-TEST-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last actionable in-repo audit remnants: a per-request timeout interceptor (OPS-RES-2), documenting optional env vars (OPS-CFG-3), and focused unit specs for the pure financial-engine logic + a raised coverage floor (OPS-TEST-2).

**Architecture:** One new global interceptor (RxJS `timeout`), a `.env.example` doc edit, three new/relocated unit specs over pure logic (tax engine, balance validation, balances signing), and a `coverageThreshold` bump. No app behavior change except a slow (>`REQUEST_TIMEOUT_MS`) request now returns 408.

**Tech Stack:** NestJS 11 interceptors + RxJS, class-validator (`env.validation.ts`), Jest + ts-jest (unit), decimal.js-backed `Money`, `@prisma/client` `Prisma.Decimal`.

## Global Constraints

- **No happy-path behavior change.** The timeout only fires above the configured limit; the extracted `assertBalanced` is verbatim-equivalent; the rest is tests/docs.
- **OPS-TEST-2 scope = pure logic only.** Tax engine (mock `taxCode.findMany`), `assertBalanced` (extracted pure helper), BalancesService signing (mock `$queryRaw`). **Year-end close stays e2e** — do NOT add brittle DB-mock unit tests for it.
- **Per-task gate:** `npm run db:generate` (cheap) + `npm run typecheck` (0) + `npm run lint:ci` (0) + the task's unit tests. The coverage-floor task additionally runs `npm run test:cov`.
- **Sequencing:** Tasks 3/4/5 (new specs) land BEFORE Task 6 (coverage-floor bump), so the floor is measured with them present.
- Known: full `npm run verify` e2e is environmentally flaky under load — confirm any failure in isolation.

---

## Task 1: Per-request timeout interceptor (OPS-RES-2)

**Files:**
- Create: `src/common/interceptors/request-timeout.interceptor.ts`
- Create: `src/common/interceptors/request-timeout.interceptor.spec.ts`
- Modify: `src/config/env.validation.ts` (add `REQUEST_TIMEOUT_MS`)
- Modify: `src/app.module.ts` (register `APP_INTERCEPTOR`)

**Interfaces:**
- Produces: `class RequestTimeoutInterceptor implements NestInterceptor` with constructor `(timeoutMs: number)`.

- [ ] **Step 1: Write the interceptor**

Create `src/common/interceptors/request-timeout.interceptor.ts`:
```ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';

/** Operational probes must never be capped (liveness/readiness/scrape). */
const PROBE_PATHS = ['/health', '/ready', '/metrics'];

/** Caps each request's handler duration independently of the HTTP server's
 *  `requestTimeout` and the DB `statement_timeout`, returning a clean 408
 *  envelope (via AllExceptionsFilter) instead of a dropped socket. */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ url?: string }>();
    const path = (req?.url ?? '').split('?')[0];
    if (PROBE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
      return next.handle();
    }
    return next.handle().pipe(
      timeout({ each: this.timeoutMs }),
      catchError((err: unknown) =>
        err instanceof TimeoutError
          ? throwError(() => new RequestTimeoutException('Request timed out'))
          : throwError(() => err),
      ),
    );
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `src/common/interceptors/request-timeout.interceptor.spec.ts`:
```ts
import { RequestTimeoutException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';

const ctx = (url: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ url }) }) }) as any;

describe('RequestTimeoutInterceptor', () => {
  it('passes through a fast response', async () => {
    const i = new RequestTimeoutInterceptor(50);
    const out = await firstValueFrom(
      i.intercept(ctx('/v1/reports/balance-sheet'), { handle: () => of('ok') }),
    );
    expect(out).toBe('ok');
  });

  it('throws 408 when the handler exceeds the limit', async () => {
    const i = new RequestTimeoutInterceptor(20);
    await expect(
      firstValueFrom(
        i.intercept(ctx('/v1/reports/balance-sheet'), {
          handle: () => of('late').pipe(delay(100)),
        }),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  it('does NOT cap operational probes', async () => {
    const i = new RequestTimeoutInterceptor(20);
    const out = await firstValueFrom(
      i.intercept(ctx('/health'), { handle: () => of('alive').pipe(delay(60)) }),
    );
    expect(out).toBe('alive');
  });
});
```

- [ ] **Step 3: Run the test → PASS**

Run: `npm test -- request-timeout` → 3 tests PASS (real timers; the 100ms/60ms delays vs 20ms cap are deterministic).

- [ ] **Step 4: Add `REQUEST_TIMEOUT_MS` to env validation**

In `src/config/env.validation.ts`, append to `EnvVars` (after `LOG_LEVEL`):
```ts
  @IsOptional()
  @IsInt()
  @Min(1000)
  REQUEST_TIMEOUT_MS?: number;
```

- [ ] **Step 5: Register the interceptor**

In `src/app.module.ts`: change the `@nestjs/core` import to `import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';`, import the interceptor, and add to the `providers` array (after the three `APP_GUARD` entries):
```ts
    {
      provide: APP_INTERCEPTOR,
      useFactory: () =>
        new RequestTimeoutInterceptor(
          Number(process.env.REQUEST_TIMEOUT_MS) || 30_000,
        ),
    },
```

- [ ] **Step 6: Gate + commit**

`npm run db:generate && npm run typecheck` → 0; `npm run lint:ci` → 0; `npm test -- request-timeout` → green. A quick boot smoke: `npm run test:e2e -- auth` → green (app still bootstraps with the new APP_INTERCEPTOR).
```bash
git add src/common/interceptors/request-timeout.interceptor.ts src/common/interceptors/request-timeout.interceptor.spec.ts src/config/env.validation.ts src/app.module.ts
git commit -m "feat(resilience): per-request timeout interceptor (408) — OPS-RES-2"
```

---

## Task 2: Document optional env vars (OPS-CFG-3)

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the optional vars**

Read `.env.example` first, then append (commented, after the existing required vars) — do not duplicate any already present:
```sh
# --- Optional ---
# REQUEST_TIMEOUT_MS=30000          # per-request handler cap (ms); returns 408 if exceeded
# METRICS_TOKEN=                     # bearer token gating /metrics (required+fail-closed in prod if set)
# SENTRY_DSN=                        # enables error reporting when set
# SENTRY_ENVIRONMENT=                # overrides NODE_ENV in Sentry events
# SENTRY_RELEASE=                    # release tag for Sentry
# THROTTLE_LIMIT=300                 # global requests / 60s per authenticated user
# THROTTLE_LOGIN_LIMIT=10            # login attempts / 60s per IP
# THROTTLE_REFRESH_LIMIT=30          # refresh+logout / 60s per IP
# LOG_LEVEL=info                     # pino level: fatal|error|warn|info|debug|trace|silent
# ENABLE_SWAGGER=false               # 'true' to expose /docs in production
# GRAFANA_ADMIN_PASSWORD=            # for the optional docker-compose.monitoring.yml overlay
```
(If `CORS_ORIGIN`/`LOG_LEVEL` are already present, keep them where they are and don't re-add.)

- [ ] **Step 2: Gate + commit**

`npm run lint:ci` → 0 (no code touched). Confirm the file lists all of `METRICS_TOKEN`, `SENTRY_DSN`, `THROTTLE_LIMIT`, `ENABLE_SWAGGER`, `GRAFANA_ADMIN_PASSWORD`.
```bash
git add .env.example
git commit -m "docs(config): document optional env vars in .env.example — OPS-CFG-3"
```

---

## Task 3: Tax-engine unit spec (OPS-TEST-2a)

**Files:**
- Create: `src/tax/tax.service.spec.ts`

**Interfaces:**
- Consumes: `new TaxService(prisma)` where `prisma.client.taxCode.findMany` is the only DB dependency; `calculate(input: TaxableTransaction): Promise<TaxCalculation>`.

- [ ] **Step 1: Write the tax-engine spec**

Create `src/tax/tax.service.spec.ts`. Build a mocked prisma whose `taxCode.findMany` returns fixed `TaxCode`-shaped rows (`{ id, code, kind, rate, taxAccountId, isActive }`; `rate` as a decimal string — `Money.multiply` accepts decimal strings, confirm against `src/common/money/money.ts`). Cover:
```ts
import { TaxService } from './tax.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

const CODES = [
  { id: 'ppn-out', code: 'PPN-OUT', kind: 'PPN_OUTPUT', rate: '0.11', taxAccountId: 'acc-ppn-out', isActive: true },
  { id: 'ppn-in', code: 'PPN-IN', kind: 'PPN_INPUT', rate: '0.11', taxAccountId: 'acc-ppn-in', isActive: true },
  { id: 'pph-pay', code: 'PPH-PAY', kind: 'PPH_PAYABLE', rate: '0.02', taxAccountId: 'acc-pph', isActive: true },
  { id: 'pph-pre', code: 'PPH-PRE', kind: 'PPH_PREPAID', rate: '0.02', taxAccountId: 'acc-pph-pre', isActive: true },
  { id: 'inactive', code: 'OLD', kind: 'PPN_OUTPUT', rate: '0.11', taxAccountId: 'acc-x', isActive: false },
];
const make = (subset = CODES) =>
  new TaxService({
    client: { taxCode: { findMany: jest.fn().mockResolvedValue(subset) } },
  } as never);

describe('TaxService.calculate', () => {
  it('SALE with PPN output: settlement = subtotal + PPN, balanced', async () => {
    const r = await make().calculate({
      nature: 'SALE', settlementAccountId: 'ar',
      lines: [{ accountId: 'rev', amount: '1000000', taxCodeIds: ['ppn-out'] }],
    });
    expect(r.subtotal).toBe('1000000.0000');
    expect(r.taxes).toHaveLength(1);
    expect(r.taxes[0].amount).toBe('110000.0000'); // 1,000,000 * 0.11
    expect(r.settlementAmount).toBe('1110000.0000');
    const dr = r.journalLines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const cr = r.journalLines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(dr).toBeCloseTo(cr); // balanced
  });

  it('PURCHASE with PPN input + PPh withholding: settlement = subtotal + PPN − PPh', async () => {
    const r = await make().calculate({
      nature: 'PURCHASE', settlementAccountId: 'ap',
      lines: [{ accountId: 'exp', amount: '1000000', taxCodeIds: ['ppn-in', 'pph-pay'] }],
    });
    // PPN 110,000 ; PPh 20,000 → settlement 1,090,000
    expect(r.settlementAmount).toBe('1090000.0000');
  });

  it('rounds each tax code to whole rupiah once', async () => {
    const r = await make().calculate({
      nature: 'SALE', settlementAccountId: 'ar',
      lines: [{ accountId: 'rev', amount: '333333', taxCodeIds: ['ppn-out'] }],
    });
    // 333,333 * 0.11 = 36,666.63 → rounds to 36,667
    expect(r.taxes[0].amount).toBe('36667.0000');
  });

  it('rejects a duplicate tax code within one line (422)', async () => {
    await expect(
      make().calculate({ nature: 'SALE', settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['ppn-out', 'ppn-out'] }] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects an unknown tax code (422)', async () => {
    await expect(
      make([]).calculate({ nature: 'SALE', settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['nope'] }] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects an inactive tax code (422)', async () => {
    await expect(
      make().calculate({ nature: 'SALE', settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['inactive'] }] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a tax kind not allowed for the nature (422)', async () => {
    await expect(
      make().calculate({ nature: 'SALE', settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['ppn-in'] }] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects when withholding leaves a non-positive settlement (422)', async () => {
    // subtotal 100, no PPN, PPh rate that exceeds gross → use a big-rate code via override
    const big = [{ id: 'pph-big', code: 'PPH-BIG', kind: 'PPH_PAYABLE', rate: '1.5', taxAccountId: 'acc', isActive: true }];
    await expect(
      make(big).calculate({ nature: 'PURCHASE', settlementAccountId: 'ap',
        lines: [{ accountId: 'exp', amount: '100', taxCodeIds: ['pph-big'] }] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects empty lines (422)', async () => {
    await expect(
      make().calculate({ nature: 'SALE', settlementAccountId: 'ar', lines: [] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
```
> If `Money.multiply` rejects a string rate, pass `rate` as a `Prisma.Decimal` (`new Prisma.Decimal('0.11')`) instead — confirm against `money.ts` and adjust the mock rows uniformly. The assertions (amounts/settlement/guards) are the contract; keep them.

- [ ] **Step 2: Run → PASS**

Run: `npm test -- "tax.service"` → all green. (If a computed amount differs because `roundToRupiah`/`toPersistence` formats differently than asserted, correct the EXPECTED string to the real output — it's characterizing existing behavior, not changing it.)

- [ ] **Step 3: Commit**

```bash
git add src/tax/tax.service.spec.ts
git commit -m "test(tax): unit-test the tax engine — rounding, withholding, guards (OPS-TEST-2)"
```

---

## Task 4: Extract `assertBalanced` to a pure helper + unit spec (OPS-TEST-2b)

**Files:**
- Create: `src/ledger/posting/assert-balanced.ts`
- Create: `src/ledger/posting/assert-balanced.spec.ts`
- Modify: `src/ledger/posting/posting.service.ts` (use the helper; delete the private method)

**Interfaces:**
- Produces: `export function assertBalanced(lines: PostLineInput[]): void` — throws `UnbalancedEntryError`.

- [ ] **Step 1: Extract the helper (verbatim logic)**

Create `src/ledger/posting/assert-balanced.ts`:
```ts
import { Money } from '../../common/money/money';
import { UnbalancedEntryError } from '../../common/errors/domain-errors';
import { PostLineInput } from './posting.types';

/** Double-entry invariant: ≥2 lines, each line exactly one of debit/credit > 0,
 *  and total debits == total credits. (Extracted from PostingService for unit testing.) */
export function assertBalanced(lines: PostLineInput[]): void {
  if (lines.length < 2) {
    throw new UnbalancedEntryError('An entry needs at least two lines');
  }
  let debit = Money.zero();
  let credit = Money.zero();
  for (const l of lines) {
    const d = Money.of(l.debit ?? '0');
    const c = Money.of(l.credit ?? '0');
    const dPos = !d.isZero();
    const cPos = !c.isZero();
    if (dPos === cPos) {
      throw new UnbalancedEntryError(
        'Each line must have exactly one of debit or credit > 0',
      );
    }
    debit = debit.add(d);
    credit = credit.add(c);
  }
  if (!debit.equals(credit)) {
    throw new UnbalancedEntryError('Total debits must equal total credits', {
      debit: debit.toString(),
      credit: credit.toString(),
    });
  }
}
```

- [ ] **Step 2: Use it in PostingService; delete the private method**

In `src/ledger/posting/posting.service.ts`: add `import { assertBalanced } from './assert-balanced';`; replace both `this.assertBalanced(...)` calls (lines ~55, ~343) with `assertBalanced(...)`; delete the private `assertBalanced` method (lines ~431-455). `Money` / `UnbalancedEntryError` imports may become unused there — remove only if no longer referenced (run lint to catch).

- [ ] **Step 3: Write the spec**

Create `src/ledger/posting/assert-balanced.spec.ts`:
```ts
import { assertBalanced } from './assert-balanced';
import { UnbalancedEntryError } from '../../common/errors/domain-errors';

describe('assertBalanced', () => {
  it('accepts a balanced two-line entry', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100.0000' },
        { accountId: 'b', credit: '100.0000' },
      ]),
    ).not.toThrow();
  });
  it('rejects fewer than two lines', () => {
    expect(() => assertBalanced([{ accountId: 'a', debit: '100' }])).toThrow(UnbalancedEntryError);
  });
  it('rejects a line with both debit and credit', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100', credit: '100' },
        { accountId: 'b', credit: '100' },
      ]),
    ).toThrow(UnbalancedEntryError);
  });
  it('rejects a line with neither debit nor credit', () => {
    expect(() =>
      assertBalanced([{ accountId: 'a' }, { accountId: 'b', credit: '100' }]),
    ).toThrow(UnbalancedEntryError);
  });
  it('rejects unequal totals', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100' },
        { accountId: 'b', credit: '90' },
      ]),
    ).toThrow(UnbalancedEntryError);
  });
  it('accepts a balanced multi-line entry', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '60' },
        { accountId: 'b', debit: '40' },
        { accountId: 'c', credit: '100' },
      ]),
    ).not.toThrow();
  });
});
```

- [ ] **Step 4: Gate + commit**

`npm run db:generate && npm run typecheck` → 0 (confirms PostingService still compiles with the extracted helper); `npm run lint:ci` → 0; `npm test -- "assert-balanced"` → green; `npm run test:e2e -- "posting|journal"` → green (behavior unchanged — same validation, same errors).
```bash
git add src/ledger/posting/assert-balanced.ts src/ledger/posting/assert-balanced.spec.ts src/ledger/posting/posting.service.ts
git commit -m "refactor(posting): extract assertBalanced to a pure helper + unit-test it (OPS-TEST-2)"
```

---

## Task 5: BalancesService signing unit spec (OPS-TEST-2c)

**Files:**
- Create: `src/ledger/balances/balances.service.spec.ts`

**Interfaces:**
- Consumes: `new BalancesService(prisma, accounts)`; `balancesAsOf(date)` calls `prisma.$queryRaw` (returns `RawBalanceRow[]` with `Prisma.Decimal` debit/credit) then maps each via the private `toRow` (TYPE/`normalBalance` signing).

- [ ] **Step 1: Write the signing spec**

Create `src/ledger/balances/balances.service.spec.ts`:
```ts
import { Prisma } from '@prisma/client';
import { BalancesService } from './balances.service';

const rawRow = (over: Partial<Record<string, unknown>>) => ({
  account_id: 'id', code: '1-1000', name: 'X', type: 'ASSET', subtype: 'CURRENT_ASSET',
  normal_balance: 'DEBIT', cash_flow_category: 'OPERATING', role: null,
  debit: new Prisma.Decimal('0'), credit: new Prisma.Decimal('0'), ...over,
});

const make = (rows: unknown[]) =>
  new BalancesService(
    { $queryRaw: jest.fn().mockResolvedValue(rows) } as never,
    {} as never,
  );

describe('BalancesService signing (toRow via balancesAsOf)', () => {
  it('DEBIT-normal account: balance = debit − credit', async () => {
    const [r] = await make([
      rawRow({ normal_balance: 'DEBIT', debit: new Prisma.Decimal('100'), credit: new Prisma.Decimal('30') }),
    ]).balancesAsOf(new Date('2026-06-30'));
    expect(r.balance).toBe('70.0000');
    expect(r.debit).toBe('100.0000');
    expect(r.credit).toBe('30.0000');
  });

  it('CREDIT-normal account: balance = credit − debit', async () => {
    const [r] = await make([
      rawRow({ code: '3-1000', type: 'EQUITY', normal_balance: 'CREDIT', debit: new Prisma.Decimal('30'), credit: new Prisma.Decimal('100') }),
    ]).balancesAsOf(new Date('2026-06-30'));
    expect(r.balance).toBe('70.0000');
  });

  it('carries metadata (role, type, cashFlowCategory) through unchanged', async () => {
    const [r] = await make([rawRow({ role: 'CASH' })]).balancesAsOf(new Date('2026-06-30'));
    expect(r.role).toBe('CASH');
    expect(r.type).toBe('ASSET');
    expect(r.cashFlowCategory).toBe('OPERATING');
  });
});
```

- [ ] **Step 2: Run → PASS**

Run: `npm test -- "balances.service"` → green. (If `balancesAsOf` calls `this.prisma.$queryRaw` with a different arity/shape than the mock expects, adjust the mock to match — confirm against `balances.service.ts:71,106`. The signing assertions are the contract.)

- [ ] **Step 3: Commit**

```bash
git add src/ledger/balances/balances.service.spec.ts
git commit -m "test(balances): unit-test TYPE-based balance signing (OPS-TEST-2)"
```

---

## Task 6: Raise the unit coverage floor (OPS-TEST-2 / ties off OPS-CI-2) — RUN LAST

**Files:**
- Modify: `package.json` (`jest.coverageThreshold`)

Must run AFTER Tasks 3/4/5 so the floor reflects the new specs.

- [ ] **Step 1: Measure**

Run: `npm run test:cov 2>/dev/null | grep -E "All files"` — record the global Stmts/Branch/Funcs/Lines.

- [ ] **Step 2: Raise the floor**

In `package.json` `jest.coverageThreshold.global`, raise each number to the new measured value **floored a few points below** (regression floor, not target) — it must be ≥ the current 18/12/14/18 (the new specs only add coverage). Example: if measured is ~25/18/22/25, set `22/15/19/22`.

- [ ] **Step 3: Verify the gate passes**

Run: `npm run test:cov` → exit 0 (coverage clears the raised floor with margin). If it fails, the floor was set too high — lower it below the measured value.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "ci(test): raise unit coverage floor after engine specs (OPS-CI-2/TEST-2)"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full gate**

Run: `npm run db:generate && npm run verify` → typecheck 0, lint:ci 0, unit all green (incl. the 4 new specs), e2e all suites green, coverage clears the raised floor. (If an unrelated e2e suite flakes, re-run it in isolation — known environmental issue.)

- [ ] **Step 2: Confirm scope**

`git diff --stat <branch-base>..HEAD` should show only: the interceptor + its spec, `env.validation.ts`, `app.module.ts`, `.env.example`, `tax.service.spec.ts`, `assert-balanced.ts` + spec + `posting.service.ts`, `balances.service.spec.ts`, `package.json`. No year-end-close unit spec (deliberately e2e). No commit if clean.

---

## Self-Review notes

- **Spec coverage:** OPS-RES-2 → Task 1; OPS-CFG-3 → Task 2; OPS-TEST-2 → Tasks 3 (tax engine), 4 (assertBalanced), 5 (balances signing), 6 (coverage floor); year-end close deliberately excluded (e2e). Task 7 = final verify.
- **No behavior change:** the interceptor only fires >timeout (default 30s, probes bypassed); `assertBalanced` extraction is verbatim (Task 4 Step 4 runs posting/journal e2e to prove it); the rest is tests/docs.
- **Type consistency:** `RequestTimeoutInterceptor(timeoutMs)` matches the app.module factory; `assertBalanced(lines: PostLineInput[])` matches both call sites + the spec; the tax/balances mocks match the real `taxCode.findMany` / `$queryRaw` shapes.
- **Watch-points:** (1) `Money.multiply` rate type — string vs `Prisma.Decimal` (Task 3 has a fallback note); (2) extracted `assertBalanced` must leave PostingService's `Money`/`UnbalancedEntryError` imports correct (lint catches unused); (3) Task 6 floor is the only runtime-measured value (raise-to-just-below-measured, ≥ current); (4) `balancesAsOf` uses `this.prisma.$queryRaw` (NOT `.client.$queryRaw`) — the mock targets `$queryRaw`.
