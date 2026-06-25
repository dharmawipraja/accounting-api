# Reporting Unit Specs (cash-flow + balance-sheet) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add solid, bug-catching unit specs for the two cleanly-unit-testable reporting services (`cash-flow`, `balance-sheet`) and lock them in with per-path thresholds, lifting unit coverage meaningfully without mock-theater.

**Architecture:** Each service delegates all DB work to `BalancesService` (+ `CompanyService` for balance-sheet) and does pure assembly. The specs construct the service with mocked data-source deps, feed crafted `AccountBalanceRow[]`, and assert the **report output** (totals, lines, `reconciles`/`balanced` flags). Real pure helpers (`Money`, `naturalSide`) are used unmocked. Pattern: `src/reporting/income-statement.service.spec.ts`.

**Tech Stack:** Jest 30 + ts-jest (unit, no DB), the existing `AccountBalanceRow` shape.

## Global Constraints

- Branch: `test/reporting-unit-specs` (already created off `main` at `c6b6714`).
- Spec: `docs/superpowers/specs/2026-06-25-reporting-unit-specs-design.md`.
- These are CHARACTERIZATION tests on correct, existing services → each PASSES on first write. If a computed expected value is off, the bug is in the test's arithmetic — fix the expectation to match the real output. **Do NOT change any `src/` service file.**
- Quality bar: assert the **report output** (returned numbers/lines/flags) — never mock-interaction counts. Mock ONLY `BalancesService` / `CompanyService`; use the real `Money` and `naturalSide`. Each test carries a one-line failure-mode note.
- `AccountBalanceRow` fields: `accountId, code, name, type, subtype, normalBalance, cashFlowCategory, role, debit, credit, balance` (all strings except none here; money fields are 4dp strings).
- `naturalSide(type, debit, credit)`: ASSET/EXPENSE → `debit − credit`; LIABILITY/EQUITY/REVENUE → `credit − debit`.
- NOT unit-90-global; NO unit tests on `aging`/`general-ledger` (own raw SQL → e2e); NO logic extraction.

---

### Task 1: `cash-flow.service.spec.ts`

**Files:**
- Create: `src/reporting/cash-flow.service.spec.ts`

**Interfaces:**
- Consumes: `CashFlowService.generate(from: Date, to: Date)`; mocks `balances.movementsBetween(from,to)` and `balances.balancesAsOf(date)` (called twice — `dayBefore` first → `kasAwal`, then `to` → `kasAkhir`; use `mockResolvedValueOnce` in that order).

- [ ] **Step 1: Write the spec**

```ts
import { CashFlowService } from './cash-flow.service';
import {
  AccountBalanceRow,
  BalancesService,
} from '../ledger/balances/balances.service';

const row = (o: Partial<AccountBalanceRow>): AccountBalanceRow => ({
  accountId: 'a',
  code: '0',
  name: 'n',
  type: 'ASSET',
  subtype: 'CURRENT_ASSET',
  normalBalance: 'DEBIT',
  cashFlowCategory: 'OPERATING',
  role: null,
  debit: '0',
  credit: '0',
  balance: '0',
  ...o,
});

const make = (
  movements: AccountBalanceRow[],
  kasAwalRows: AccountBalanceRow[],
  kasAkhirRows: AccountBalanceRow[],
) =>
  new CashFlowService({
    movementsBetween: jest.fn().mockResolvedValue(movements),
    balancesAsOf: jest
      .fn()
      .mockResolvedValueOnce(kasAwalRows) // dayBefore → kasAwal
      .mockResolvedValueOnce(kasAkhirRows), // to → kasAkhir
  } as unknown as BalancesService);

const FROM = new Date('2026-01-01');
const TO = new Date('2026-12-31');

describe('CashFlowService.generate', () => {
  // Movements shared by both reconcile cases. netIncome=1000, OPERATING section=250
  // (AP 200 + NONE-category 50), INVESTING=-300, FINANCING=500 → netChange=1450.
  // The CASH-role movement (9999) must be excluded; the zero-effect row produces no line.
  const movements = [
    row({ code: 'REV', type: 'REVENUE', credit: '1000' }), // P&L → netIncome
    row({ code: 'AP', type: 'LIABILITY', cashFlowCategory: 'OPERATING', credit: '200' }),
    row({ code: 'EQUIP', type: 'ASSET', cashFlowCategory: 'INVESTING', debit: '300' }),
    row({ code: 'LOAN', type: 'LIABILITY', cashFlowCategory: 'FINANCING', credit: '500' }),
    row({ code: 'ZERO', type: 'LIABILITY', cashFlowCategory: 'OPERATING' }), // zero-effect → skipped
    row({ code: 'OTHER', type: 'LIABILITY', cashFlowCategory: 'NONE', credit: '50' }), // NONE → OPERATING
    row({ code: 'CASHMOVE', type: 'ASSET', role: 'CASH', debit: '9999' }), // excluded (role CASH)
  ];

  it('assembles the indirect statement and reconciles when kasAwal + netChange === kasAkhir', async () => {
    const svc = make(
      movements,
      [row({ code: 'KAS', role: 'CASH', debit: '100' })], // kasAwal = 100
      [row({ code: 'KAS', role: 'CASH', debit: '1550' })], // kasAkhir = 1550 = 100 + 1450
    );
    const r = await svc.generate(FROM, TO);

    expect(r.netIncome).toBe('1000.0000'); // Σ cash-effect of P&L (CASH movement excluded)
    expect(r.operating.total).toBe('1250.0000'); // netIncome 1000 + OPERATING 250
    expect(r.investing.total).toBe('-300.0000');
    expect(r.financing.total).toBe('500.0000');
    expect(r.netChange).toBe('1450.0000');
    expect(r.kasAwal).toBe('100.0000');
    expect(r.kasAkhir).toBe('1550.0000');
    expect(r.reconciles).toBe(true);
    // NONE → OPERATING, zero-effect skipped, CASH movement excluded:
    const opCodes = r.operating.adjustments.map((l) => l.code);
    expect(opCodes).toEqual(expect.arrayContaining(['AP', 'OTHER']));
    expect(opCodes).not.toContain('ZERO');
    expect(opCodes).not.toContain('CASHMOVE');
  });

  it('flags reconciles=false when the cash delta does not match netChange', async () => {
    const svc = make(
      movements,
      [row({ code: 'KAS', role: 'CASH', debit: '100' })],
      [row({ code: 'KAS', role: 'CASH', debit: '9999' })], // 9999 != 100 + 1450
    );
    const r = await svc.generate(FROM, TO);
    expect(r.reconciles).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect PASS** (characterization)

Run: `npm run test:cov -- cash-flow.service.spec`
Expected: PASS, `cash-flow.service.ts` at/near 100%. If any expected value mismatches the actual output, correct the EXPECTATION (the service is correct) — do not touch `src/`.

- [ ] **Step 3: Commit**

```bash
git add src/reporting/cash-flow.service.spec.ts
git commit -m "test(unit): cover CashFlowService.generate (indirect-method assembly + reconciliation)"
```

---

### Task 2: `balance-sheet.service.spec.ts`

**Files:**
- Create: `src/reporting/balance-sheet.service.spec.ts`

**Interfaces:**
- Consumes: `BalanceSheetService.generate(asOf: Date)`; mocks `company.fiscalYearFor(asOf)` → number, `company.fiscalYearBounds(fy)` → `{ start: Date }`, `balances.balancesAsOf(asOf)`, `balances.movementsBetween(fyStart, asOf)`.

- [ ] **Step 1: Write the spec**

```ts
import { BalanceSheetService } from './balance-sheet.service';
import {
  AccountBalanceRow,
  BalancesService,
} from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';

const row = (o: Partial<AccountBalanceRow>): AccountBalanceRow => ({
  accountId: 'a',
  code: '0',
  name: 'n',
  type: 'ASSET',
  subtype: 'CURRENT_ASSET',
  normalBalance: 'DEBIT',
  cashFlowCategory: 'OPERATING',
  role: null,
  debit: '0',
  credit: '0',
  balance: '0',
  ...o,
});

const make = (asOfRows: AccountBalanceRow[], fyRows: AccountBalanceRow[]) =>
  new BalanceSheetService(
    {
      balancesAsOf: jest.fn().mockResolvedValue(asOfRows),
      movementsBetween: jest.fn().mockResolvedValue(fyRows),
    } as unknown as BalancesService,
    {
      fiscalYearFor: jest.fn().mockResolvedValue(2026),
      fiscalYearBounds: jest
        .fn()
        .mockResolvedValue({ start: new Date('2026-01-01'), end: new Date('2026-12-31') }),
    } as unknown as CompanyService,
  );

const AS_OF = new Date('2026-06-30');

describe('BalanceSheetService.generate', () => {
  it('assembles A/L/E with a contra-asset, synthetic earnings, and balances', async () => {
    // assets: cash 1300 + Akumulasi (contra, credit 300 → -300) = 1000
    // liabilities: AP 400 ; equity capital 500
    // cumulative earnings: REV(credit 200) + EXP(debit 100 → -100) = 100 → totalEquity = 600
    // balanced: 1000 === 400 + 600
    const asOfRows = [
      row({ code: 'KAS', type: 'ASSET', subtype: 'CURRENT_ASSET', debit: '1300' }),
      row({ code: 'AKUM', type: 'ASSET', subtype: 'FIXED_ASSET', credit: '300' }), // contra → -300
      row({ code: 'AP', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', credit: '400' }),
      row({ code: 'CAP', type: 'EQUITY', subtype: 'CAPITAL', credit: '500' }),
      row({ code: 'REV', type: 'REVENUE', subtype: 'REVENUE', credit: '200' }),
      row({ code: 'EXP', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', debit: '100' }),
    ];
    // current-FY earnings is a SEPARATE figure from movementsBetween (80, not 100)
    const fyRows = [row({ code: 'REV', type: 'REVENUE', credit: '80' })];

    const svc = make(asOfRows, fyRows);
    const r = await svc.generate(AS_OF);

    expect(r.totalAssets).toBe('1000.0000'); // 1300 − 300 contra
    expect(r.totalLiabilities).toBe('400.0000');
    expect(r.totalEquity).toBe('600.0000'); // capital 500 + cumulative earnings 100
    expect(r.currentYearEarnings).toBe('80.0000'); // from movementsBetween, not cumulative
    expect(r.balanced).toBe(true);
    // the synthetic CURRENT_EARNINGS equity group carries the cumulative figure:
    const ce = r.equity.groups.find((g) => g.subtype === 'CURRENT_EARNINGS');
    expect(ce?.subtotal).toBe('100.0000');
    // the contra asset reads negative in its group line:
    const akum = r.assets.groups
      .flatMap((g) => g.lines)
      .find((l) => l.code === 'AKUM');
    expect(akum?.amount).toBe('-300.0000');
  });

  it('flags balanced=false when assets != liabilities + equity', async () => {
    // drop the contra → assets 1300, but L+E still 1000 → unbalanced
    const asOfRows = [
      row({ code: 'KAS', type: 'ASSET', debit: '1300' }),
      row({ code: 'AP', type: 'LIABILITY', credit: '400' }),
      row({ code: 'CAP', type: 'EQUITY', credit: '500' }),
      row({ code: 'REV', type: 'REVENUE', credit: '200' }),
      row({ code: 'EXP', type: 'EXPENSE', debit: '100' }),
    ];
    const svc = make(asOfRows, []);
    const r = await svc.generate(AS_OF);
    expect(r.totalAssets).toBe('1300.0000');
    expect(r.balanced).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect PASS** (characterization)

Run: `npm run test:cov -- balance-sheet.service.spec`
Expected: PASS, `balance-sheet.service.ts` at/near 100%. If a value mismatches, correct the EXPECTATION — do not touch `src/`.

- [ ] **Step 3: Commit**

```bash
git add src/reporting/balance-sheet.service.spec.ts
git commit -m "test(unit): cover BalanceSheetService.generate (A/L/E, contra, synthetic earnings, balanced)"
```

---

### Task 3: Lock in per-path thresholds + bump the unit global floor

**Files:**
- Modify: `package.json` (`jest.coverageThreshold`)

- [ ] **Step 1: Measure achieved unit coverage**

Run: `npm run test:cov`
Record the new global `All files` line (stmts/branch/funcs/lines — expected ~high-30s/low-40s, up from 31.7) and confirm `cash-flow.service.ts` + `balance-sheet.service.ts` + `income-statement.service.ts` are each ≥ 90% on all four metrics.

- [ ] **Step 2: Add per-path thresholds + bump the global floor**

In `package.json` `jest.coverageThreshold`, set `global` to `Math.floor` of the achieved metrics (≤ achieved — anti-regression, NOT 90), and add three per-path keys at 90:

```jsonc
"coverageThreshold": {
  "global": { "statements": <achieved>, "branches": <achieved>, "functions": <achieved>, "lines": <achieved> },
  "**/reporting/cash-flow.service.ts": { "statements": 90, "branches": 90, "functions": 90, "lines": 90 },
  "**/reporting/balance-sheet.service.ts": { "statements": 90, "branches": 90, "functions": 90, "lines": 90 },
  "**/reporting/income-statement.service.ts": { "statements": 90, "branches": 90, "functions": 90, "lines": 90 }
}
```

- [ ] **Step 3: Verify the thresholds bind and pass**

Run: `npm run test:cov`
Expected: PASS. Confirm jest does NOT warn that a per-path pattern matched no file (if it does, adjust the glob — e.g. `./reporting/cash-flow.service.ts` relative to `rootDir: src`). The three reporting services must each satisfy the 90 per-path gate; the global floor must hold.

- [ ] **Step 4: Full verify** (unit + e2e + merged gate)

Run: `npm run verify`
Expected: green — typecheck + lint + `test:cov:all`. The merged `nyc` gate ticks up slightly and still passes.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "test(unit): per-path 90 on the 3 unit-tested reporting services + bump unit global floor"
```

---

## Notes for the executor

- Tasks 1–2 are characterization tests of correct services — they PASS on first write. The RED you care about is a future regression. If a computed expectation is wrong, the service output is the source of truth — fix the test number, never the service.
- Only `BalancesService` / `CompanyService` are mocked (the data sources). `Money` and `naturalSide` run for real — that's what makes these catch real assembly/sign bugs.
- If the per-path glob form doesn't bind in Task 3, the fallback is a path relative to `rootDir: src` (`./reporting/<file>.service.ts`); confirm via the test:cov output that the pattern matched.
