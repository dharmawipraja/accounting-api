# Buku: partner-code search + journal-entry preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the already-shipped `?q=` document search to also match partner `code`, and add a read-only `POST /v1/journal-entries/preview` that returns the exact balanced journal entry a sales invoice / purchase bill / payment would post — reusing the real posting derivation, never a copy.

**Architecture:** Task 1 is a two-line change to the partner join columns already used by `trigramSearch`. Task 2 adds one thin controller + service in the invoicing module: SALE/PURCHASE reuse `TaxService.calculate().journalLines`; PAYMENT reuses `buildPaymentLines()` + control-account-by-role. A shared `PostingService.resolvePostableAccounts()` (extracted from the post path) does account validation + enrichment; a pure `toPreview()` does projection/totals.

**Tech Stack:** NestJS, Prisma 7 (pg adapter), PostgreSQL (pg_trgm), class-validator/class-transformer, Jest + Supertest + Testcontainers.

## Global Constraints

- **Money is 4-dp decimal strings**, always produced via `Money.of(x).toPersistence()`. Non-active debit/credit side is `"0.0000"`, never null/omitted.
- **Enums are exact uppercase**: `nature` ∈ `SALE|PURCHASE|PAYMENT`; `direction` ∈ `RECEIPT|DISBURSEMENT`.
- **Do not change** the list `{data,total,limit,offset}` envelope or the `/v1/tax/calculate` contract — extend only.
- **Reuse, never reimplement, the GL derivation** — SALE/PURCHASE via `TaxService.calculate`, PAYMENT via `buildPaymentLines`. Preview and real post must never diverge.
- **e2e specs** boot via `bootstrapTestApp()` (test/e2e-helpers.ts); the default pipe mirrors prod (`whitelist + transform + forbidNonWhitelisted`). All routes are under `/v1` (URI versioning already enabled in the harness).
- **Unit tests go on PURE code only** (repo's mock-theater rule). Integration glue (controllers/services touching Prisma) is covered by e2e; the *merged* nyc gate (`npm run test:cov:all`, 90/86/90/90) is the real merge gate. The unit jest floor (31/31/27/31) is anti-regression — keep glue thin so the pure projection carries the logic.
- **Branch:** work on `feat/buku-search-and-journal-preview` (already created). Commit per task. Do **not** push (repo convention: fast-forward merge to main, unpushed).
- Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Key seeded COA codes** (from `AccountsService.seedIfEmpty()`): `1-1000` Kas/Bank (postable cash), `1-1200` AR control (Piutang, role `AR_CONTROL`), `2-1000` AP control (Utang, role `AP_CONTROL`), `4-1000` revenue, `5-2000` expense, `2-1100` PPN Keluaran, `1-1400` PPN Masukan, `1-1500` PPh prepaid, `2-1200` PPh payable. Tax codes: `PPN-OUT-11`, `PPN-IN-11`, `PPH23-PRE`, `PPH23-PAY`.

---

## Task 1: Match partner `code` in `?q=` document search

Extends the existing partner join (currently `name` only) to also match `code`. Backed by the existing `business_partners_code_trgm` GIN index. No DTO/route changes.

**Files:**
- Modify: `src/invoicing/taxed-document.service.ts` (the `listPage` join, ~line 176-181)
- Modify: `src/invoicing/payments.service.ts` (the `listPage` join, ~line 180-185)
- Test: `test/sales-invoices.e2e-spec.ts` (existing `search (?q=)` block)
- Test: `test/purchase-bills.e2e-spec.ts` (existing `search (?q=)` block)
- Test: `test/payments.e2e-spec.ts` (existing `search (?q=)` block)

**Interfaces:**
- Consumes: `trigramSearch` `TrigramJoin.columns: string[]` (already accepts multiple joined columns).
- Produces: nothing new; behavior change only (partner `code` now matched alongside `name`).

- [ ] **Step 1: Write the failing e2e test (sales-invoices)**

In `test/sales-invoices.e2e-spec.ts`, inside the existing `describe('search (?q=)', …)` block (after the "matches by partner name" test, ~line 251), add. The search partner in that block is `code: 'CUST-SRCH', name: 'PT Budi Jaya'` with two invoices.

```ts
    it('matches by partner code substring, returning that partner\'s invoices', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=srch')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { total: number };
      // Both CUST-SRCH invoices match on the partner code (case-insensitive).
      expect(body.total).toBeGreaterThanOrEqual(2);
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json sales-invoices -t "partner code substring"`
Expected: FAIL — `total` is 0 (partner `code` not yet searched). (Requires Docker for Testcontainers; ~60-120s.)

- [ ] **Step 3: Add `'code'` to the partner join in `taxed-document.service.ts`**

In `src/invoicing/taxed-document.service.ts`, the `listPage` method's `trigramSearch` call:

```ts
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name', 'code'],
          },
```

- [ ] **Step 4: Add `'code'` to the partner join in `payments.service.ts`**

In `src/invoicing/payments.service.ts`, the `listPage` method's `trigramSearch` call:

```ts
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name', 'code'],
          },
```

- [ ] **Step 5: Add the partner-code test for purchase-bills**

In `test/purchase-bills.e2e-spec.ts`, inside the existing `search (?q=)` block, add (search partner is `code: 'VEND-SRCH', name: 'PT Sumber Makmur'`):

```ts
    it('matches by partner code substring, returning that vendor\'s bills', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/purchase-bills?q=vend-srch')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
    });
```

- [ ] **Step 6: Add the partner-code test for payments**

In `test/payments.e2e-spec.ts`, inside the existing `search (?q=)` block, add a second test. `newCustomer(codeStr)` creates a partner whose `code` is `codeStr`; `makePostedInvoice` returns a POSTED invoice id.

```ts
    it('matches a payment by partner code, composing with direction', async () => {
      const customerId = await newCustomer('PAYCODE-ZED');
      const invoiceId = await makePostedInvoice(customerId);
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-15',
          cashAccountId: acc['1-1000'],
          description: 'Pelunasan',
          allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
        })
        .expect(201);
      const res = await request(server())
        .get('/v1/payments?q=paycode-zed&direction=RECEIPT')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((res.body as { total: number }).total).toBeGreaterThanOrEqual(1);
    });
```

- [ ] **Step 7: Run all three search specs to verify they pass**

Run: `npx jest --config ./test/jest-e2e.json sales-invoices purchase-bills payments -t "partner code"`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/invoicing/taxed-document.service.ts src/invoicing/payments.service.ts test/sales-invoices.e2e-spec.ts test/purchase-bills.e2e-spec.ts test/payments.e2e-spec.ts
git commit -m "feat(search): match partner code in ?q= document search

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `PostingService.resolvePostableAccounts`

Makes the account-postable validation reusable + return the fetched accounts, so the preview reuses the *same* rule set for validation AND for code/name enrichment. Pure refactor — the post path's behavior is unchanged.

**Files:**
- Modify: `src/ledger/posting/posting.service.ts` (add public method ~line 479; adapt `assertPostableAccounts`; add `Account` import ~line 2)
- Test: existing `test/posting.e2e-spec.ts` (behavior parity — no new test)

**Interfaces:**
- Produces: `PostingService.resolvePostableAccounts(ids: string[]): Promise<Map<string, Account>>` — throws `InvalidAccountError` for a missing / non-postable / inactive id; on success the returned map has an entry for every requested id.

- [ ] **Step 1: Add `Account` to the prisma import**

In `src/ledger/posting/posting.service.ts`, line 2:

```ts
import { Account, JournalEntry, Prisma } from '@prisma/client';
```

- [ ] **Step 2: Replace the private `assertPostableAccounts` with the public resolver + a thin wrapper**

Replace the existing `assertPostableAccounts` method (currently ~lines 479-499) with:

```ts
  /** Validate every id is an existing, postable, active account and return the
   *  accounts keyed by id. The single source of postable-account validation: the
   *  post path asserts through it; the preview reuses the returned map to enrich
   *  journal lines with code/name (one fetch, one rule set). */
  async resolvePostableAccounts(ids: string[]): Promise<Map<string, Account>> {
    const unique = [...new Set(ids)];
    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: unique } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of unique) {
      const a = byId.get(id);
      if (!a)
        throw new InvalidAccountError('Account not found', { accountId: id });
      if (!a.isPostable)
        throw new InvalidAccountError('Account is not postable (header account)', {
          accountId: id,
        });
      if (!a.isActive)
        throw new InvalidAccountError('Account is inactive', { accountId: id });
    }
    return byId;
  }

  private async assertPostableAccounts(lines: PostLineInput[]): Promise<void> {
    await this.resolvePostableAccounts(lines.map((l) => l.accountId));
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the posting e2e to confirm behavior parity**

Run: `npx jest --config ./test/jest-e2e.json posting.e2e`
Expected: PASS — the existing "account not found / not postable / inactive → 422" cases still hold (they now flow through `resolvePostableAccounts`).

- [ ] **Step 5: Commit**

```bash
git add src/ledger/posting/posting.service.ts
git commit -m "refactor(posting): extract resolvePostableAccounts (validate + return accounts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure `toPreview` projection

The pure core of the preview: enrich derived journal lines with account code/name, normalize both sides to 4-dp, total, and set `balanced`. Unit-tested (no I/O).

**Files:**
- Create: `src/invoicing/journal-preview.projection.ts`
- Test: `src/invoicing/journal-preview.projection.spec.ts`

**Interfaces:**
- Consumes: `Money` (`src/common/money/money`) — `Money.of(str)`, `.toPersistence()`, `Money.sum(Money[])`, `.equals(Money)`.
- Produces:
  - `interface PreviewSourceLine { accountId: string; debit?: string; credit?: string }`
  - `interface PreviewLine { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }`
  - `interface JournalPreview { lines: PreviewLine[]; totalDebit: string; totalCredit: string; balanced: boolean }`
  - `function toPreview(lines: PreviewSourceLine[], accounts: Map<string, { id: string; code: string; name: string }>): JournalPreview`

- [ ] **Step 1: Write the failing unit test**

Create `src/invoicing/journal-preview.projection.spec.ts`:

```ts
import { toPreview, PreviewSourceLine } from './journal-preview.projection';

const accounts = new Map([
  ['a1', { id: 'a1', code: '1-1210', name: 'Piutang Usaha' }],
  ['a2', { id: 'a2', code: '4-1000', name: 'Pendapatan' }],
  ['a3', { id: 'a3', code: '2-1310', name: 'PPN Keluaran' }],
]);

describe('toPreview', () => {
  it('enriches, normalizes to 4dp, totals, and marks balanced', () => {
    const lines: PreviewSourceLine[] = [
      { accountId: 'a1', debit: '1110000' },
      { accountId: 'a2', credit: '1000000' },
      { accountId: 'a3', credit: '110000' },
    ];
    const out = toPreview(lines, accounts);
    expect(out.lines[0]).toEqual({
      accountId: 'a1',
      accountCode: '1-1210',
      accountName: 'Piutang Usaha',
      debit: '1110000.0000',
      credit: '0.0000', // inactive side is "0.0000", never null
    });
    expect(out.lines[1].credit).toBe('1000000.0000');
    expect(out.lines[1].debit).toBe('0.0000');
    expect(out.totalDebit).toBe('1110000.0000');
    expect(out.totalCredit).toBe('1110000.0000');
    expect(out.balanced).toBe(true);
  });

  it('reports balanced=false when debits != credits (defensive)', () => {
    const out = toPreview(
      [
        { accountId: 'a1', debit: '100' },
        { accountId: 'a2', credit: '90' },
      ],
      accounts,
    );
    expect(out.balanced).toBe(false);
  });

  it('throws if a line references an account absent from the map', () => {
    expect(() => toPreview([{ accountId: 'missing', debit: '1' }], accounts)).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest journal-preview.projection`
Expected: FAIL — `Cannot find module './journal-preview.projection'`.

- [ ] **Step 3: Implement the projection**

Create `src/invoicing/journal-preview.projection.ts`:

```ts
import { Money } from '../common/money/money';

/** A raw journal line as produced by the posting derivation (exactly one side set). */
export interface PreviewSourceLine {
  accountId: string;
  debit?: string;
  credit?: string;
}

/** An enriched, fully-normalized preview line (both sides present, 4dp strings). */
export interface PreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

export interface JournalPreview {
  lines: PreviewLine[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

/** Pure projection: enrich each derived journal line with its account code/name,
 *  normalize both sides to 4dp strings (inactive side "0.0000"), and total the
 *  entry. `accounts` must contain every line's accountId — the caller validates
 *  and fetches via PostingService.resolvePostableAccounts. */
export function toPreview(
  lines: PreviewSourceLine[],
  accounts: Map<string, { id: string; code: string; name: string }>,
): JournalPreview {
  const previewLines: PreviewLine[] = lines.map((l) => {
    const a = accounts.get(l.accountId);
    if (!a)
      throw new Error(`Account ${l.accountId} missing from preview account map`);
    return {
      accountId: l.accountId,
      accountCode: a.code,
      accountName: a.name,
      debit: Money.of(l.debit ?? '0').toPersistence(),
      credit: Money.of(l.credit ?? '0').toPersistence(),
    };
  });
  const totalDebit = Money.sum(previewLines.map((l) => Money.of(l.debit)));
  const totalCredit = Money.sum(previewLines.map((l) => Money.of(l.credit)));
  return {
    lines: previewLines,
    totalDebit: totalDebit.toPersistence(),
    totalCredit: totalCredit.toPersistence(),
    balanced: totalDebit.equals(totalCredit),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest journal-preview.projection`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/journal-preview.projection.ts src/invoicing/journal-preview.projection.spec.ts
git commit -m "feat(invoicing): pure toPreview journal projection + unit tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Preview endpoint — SALE/PURCHASE path

Builds the endpoint end-to-end for taxed documents: request/response DTOs, service (taxed derivation), controller, module wiring, and e2e proving the preview equals both `/tax/calculate` and a real posted invoice's GL.

**Files:**
- Create: `src/invoicing/dto/preview-journal-entry.dto.ts`
- Create: `src/invoicing/dto/journal-preview-response.dto.ts`
- Create: `src/invoicing/journal-preview.service.ts`
- Create: `src/invoicing/journal-preview.controller.ts`
- Modify: `src/invoicing/invoicing.module.ts`
- Test: `test/journal-preview.e2e-spec.ts`

**Interfaces:**
- Consumes: `TaxableLineDto` (from `../../tax/dto/calculate-tax.dto`); `TaxService.calculate` (returns `{ journalLines: {accountId,debit?,credit?}[] }`); `PostingService.resolvePostableAccounts` (Task 2); `toPreview` / `JournalPreview` / `PreviewSourceLine` (Task 3); `ApiMoney` (`../../common/openapi/api-money.decorator`).
- Produces:
  - `class PreviewJournalEntryDto { nature; settlementAccountId?; lines? }` (SALE/PURCHASE fields; PAYMENT fields added in Task 5)
  - `class JournalPreviewResponseDto`, `class JournalPreviewLineDto`
  - `JournalPreviewService.preview(dto): Promise<JournalPreview>`
  - `POST /v1/journal-entries/preview`

- [ ] **Step 1: Write the failing e2e (taxed path)**

Create `test/journal-preview.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Money } from '../src/common/money/money';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Journal preview (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string;
  let appr: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;

  const server = () => app.getHttpServer() as App;
  const norm = (v: string | { toString(): string }) =>
    Money.of(v.toString()).toPersistence();

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({ email: 'acct@jp.test', password: 'secret123', name: 'A', role: 'ACCOUNTANT' });
    await users.create({ email: 'appr@jp.test', password: 'secret123', name: 'B', role: 'APPROVER' });
    acct = (await app.get(AuthService).login('acct@jp.test', 'secret123')).accessToken;
    appr = (await app.get(AuthService).login('appr@jp.test', 'secret123')).accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (
      await app.get(BusinessPartnersService).create({ code: 'CUST-JP', name: 'Pelanggan', isCustomer: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const saleBody = () => ({
    nature: 'SALE',
    settlementAccountId: acc['1-1200'], // AR control
    lines: [{ accountId: acc['4-1000'], amount: '1000000', taxCodeIds: [code['PPN-OUT-11']] }],
  });

  it('SALE preview: balanced, enriched with code/name, equals /tax/calculate lines', async () => {
    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as {
      lines: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }[];
      totalDebit: string;
      totalCredit: string;
      balanced: boolean;
    };
    expect(preview.balanced).toBe(true);
    expect(preview.totalDebit).toBe(preview.totalCredit);
    const ar = preview.lines.find((l) => l.accountId === acc['1-1200'])!;
    expect(ar.debit).toBe('1110000.0000');
    expect(ar.credit).toBe('0.0000');
    expect(ar.accountCode).toBe('1-1200');
    expect(ar.accountName.length).toBeGreaterThan(0);

    const calc = (
      await request(server())
        .post('/v1/tax/calculate')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as { journalLines: { accountId: string; debit?: string; credit?: string }[] };
    // Same accounts + amounts as the tax engine's journalLines (the post derivation).
    for (const jl of calc.journalLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl.debit).toBe(norm(jl.debit ?? '0'));
      expect(pl.credit).toBe(norm(jl.credit ?? '0'));
    }
  });

  it("preview can't lie: matches a real posted invoice's GL exactly", async () => {
    const draft = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: customerId,
        date: '2026-02-10',
        description: 'Preview parity',
        lines: [{ description: 'Jasa', accountId: acc['4-1000'], quantity: '1', unitPrice: '1000000', taxCodeIds: [code['PPN-OUT-11']] }],
      })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(server())
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const journalEntryId = (posted.body as { journalEntryId: string }).journalEntryId;
    const jeLines = await prisma.client.journalEntryLine.findMany({
      where: { journalEntryId },
      orderBy: { lineNo: 'asc' },
    });

    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as { lines: { accountId: string; debit: string; credit: string }[] };

    // Every posted GL line has a matching preview line with identical debit/credit.
    for (const jl of jeLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl).toBeDefined();
      expect(pl.debit).toBe(norm(jl.debit));
      expect(pl.credit).toBe(norm(jl.credit));
    }
    expect(preview.lines.length).toBe(jeLines.length);
  });

  it('does not write any journal entry (read-only) and needs no Idempotency-Key', async () => {
    const before = await prisma.client.journalEntry.count();
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send(saleBody())
      .expect(200); // no Idempotency-Key header set → still 200, not 422
    const after = await prisma.client.journalEntry.count();
    expect(after).toBe(before);
  });

  it('rejects a non-postable (header) account with 422', async () => {
    const header = await prisma.client.account.findFirst({ where: { isPostable: false } });
    expect(header).not.toBeNull();
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({ nature: 'SALE', settlementAccountId: acc['1-1200'], lines: [{ accountId: header!.id, amount: '1000000', taxCodeIds: [] }] })
      .expect(422);
  });

  it('rejects an unknown tax code with 422', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({ nature: 'SALE', settlementAccountId: acc['1-1200'], lines: [{ accountId: acc['4-1000'], amount: '1000000', taxCodeIds: [randomUUID()] }] })
      .expect(422);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json journal-preview`
Expected: FAIL — `404` (route not registered).

- [ ] **Step 3: Create the request DTO (SALE/PURCHASE only for now)**

Create `src/invoicing/dto/preview-journal-entry.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsUUID, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TaxableLineDto } from '../../tax/dto/calculate-tax.dto';

export type PreviewNature = 'SALE' | 'PURCHASE';

/** Preview a document's journal entry. SALE/PURCHASE use the /tax/calculate shape. */
export class PreviewJournalEntryDto {
  @ApiProperty({ enum: ['SALE', 'PURCHASE'] })
  @IsIn(['SALE', 'PURCHASE'])
  nature!: PreviewNature;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  settlementAccountId!: string;

  @ApiProperty({ type: [TaxableLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines!: TaxableLineDto[];
}
```

- [ ] **Step 4: Create the response DTO**

Create `src/invoicing/dto/journal-preview-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class JournalPreviewLineDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ example: '1-1210' }) accountCode!: string;
  @ApiProperty({ example: 'Piutang Usaha' }) accountName!: string;
  @ApiMoney({ description: 'Debit, 4dp string ("0.0000" if this is a credit line)' }) debit!: string;
  @ApiMoney({ description: 'Credit, 4dp string ("0.0000" if this is a debit line)' }) credit!: string;
}

export class JournalPreviewResponseDto {
  @ApiProperty({ type: [JournalPreviewLineDto] }) lines!: JournalPreviewLineDto[];
  @ApiMoney() totalDebit!: string;
  @ApiMoney() totalCredit!: string;
  @ApiProperty({ example: true }) balanced!: boolean;
}
```

- [ ] **Step 5: Create the service (taxed derivation)**

Create `src/invoicing/journal-preview.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { TaxService } from '../tax/tax.service';
import { PostingService } from '../ledger/posting/posting.service';
import { toPreview, JournalPreview, PreviewSourceLine } from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';

@Injectable()
export class JournalPreviewService {
  constructor(
    private readonly tax: TaxService,
    private readonly posting: PostingService,
  ) {}

  async preview(dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    const lines = await this.taxedLines(dto);
    const accounts = await this.posting.resolvePostableAccounts(lines.map((l) => l.accountId));
    return toPreview(lines, accounts);
  }

  /** SALE/PURCHASE: reuse TaxService.calculate — the exact derivation the post path uses. */
  private async taxedLines(dto: PreviewJournalEntryDto): Promise<PreviewSourceLine[]> {
    const calc = await this.tax.calculate({
      nature: dto.nature,
      settlementAccountId: dto.settlementAccountId,
      lines: dto.lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        taxCodeIds: l.taxCodeIds,
      })),
    });
    return calc.journalLines;
  }
}
```

- [ ] **Step 6: Create the controller**

Create `src/invoicing/journal-preview.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JournalPreviewService } from './journal-preview.service';
import { JournalPreview } from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';
import { JournalPreviewResponseDto } from './dto/journal-preview-response.dto';

@ApiTags('Journal entries')
@ApiBearerAuth()
@Controller('journal-entries')
export class JournalPreviewController {
  constructor(private readonly service: JournalPreviewService) {}

  @ApiOkResponse({ type: JournalPreviewResponseDto })
  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    return this.service.preview(dto);
  }
}
```

- [ ] **Step 7: Wire the controller + service into the invoicing module**

In `src/invoicing/invoicing.module.ts`, add the imports and register:

```ts
import { JournalPreviewService } from './journal-preview.service';
import { JournalPreviewController } from './journal-preview.controller';
```

Add `JournalPreviewService` to the `providers` array and `JournalPreviewController` to the `controllers` array.

- [ ] **Step 8: Typecheck, then run the e2e**

Run: `npm run typecheck && npx jest --config ./test/jest-e2e.json journal-preview`
Expected: PASS (5 tests). (`TaxService` + `PostingService` are already available in the invoicing module via `TaxModule` + `LedgerModule` imports.)

- [ ] **Step 9: Commit**

```bash
git add src/invoicing/dto/preview-journal-entry.dto.ts src/invoicing/dto/journal-preview-response.dto.ts src/invoicing/journal-preview.service.ts src/invoicing/journal-preview.controller.ts src/invoicing/invoicing.module.ts test/journal-preview.e2e-spec.ts
git commit -m "feat(invoicing): POST /journal-entries/preview for sales invoices & bills

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Preview endpoint — PAYMENT path

Widens the endpoint to payments: extends the DTO with the payment body, adds the payment derivation (reusing `buildPaymentLines` + control-by-role), and proves parity against a real posted payment.

**Files:**
- Modify: `src/invoicing/dto/preview-journal-entry.dto.ts`
- Modify: `src/invoicing/journal-preview.service.ts`
- Test: `test/journal-preview.e2e-spec.ts`

**Interfaces:**
- Consumes: `AllocationDto` (from `./create-payment.dto`); `PAYMENT_TARGETS`, `buildPaymentLines`, `AllocationInput` (from `./payment-targets`); `findControlAccountId` (from `./document-helpers`); `Money`; `ValidationFailedError` (from `../common/errors/domain-errors`).
- Produces: `nature` widened to `SALE|PURCHASE|PAYMENT`; `direction?`, `cashAccountId?`, `allocations?` on the DTO; `JournalPreviewService.paymentLines`.

- [ ] **Step 1: Add the failing PAYMENT e2e tests**

Append inside the `describe('Journal preview (e2e)', …)` block in `test/journal-preview.e2e-spec.ts`:

```ts
  it("PAYMENT preview can't lie: matches a real posted receipt's GL exactly", async () => {
    // A posted invoice to allocate against.
    const inv = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ partnerId: customerId, date: '2026-02-10', description: 'For payment',
        lines: [{ description: 'Jasa', accountId: acc['4-1000'], quantity: '1', unitPrice: '1000000', taxCodeIds: [] }] })
      .expect(201);
    const invId = (inv.body as { id: string }).id;
    await request(server())
      .post(`/v1/sales-invoices/${invId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    const paymentBody = {
      nature: 'PAYMENT',
      direction: 'RECEIPT',
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: invId, amount: '400000' }],
    };

    // Post a real payment with the same cash account + allocation total.
    const pay = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ direction: 'RECEIPT', partnerId: customerId, date: '2026-02-15', cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invId, amount: '400000' }] })
      .expect(201);
    const payId = (pay.body as { id: string }).id;
    const postedPay = await request(server())
      .post(`/v1/payments/${payId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const journalEntryId = (postedPay.body as { journalEntryId: string }).journalEntryId;
    const jeLines = await prisma.client.journalEntryLine.findMany({
      where: { journalEntryId }, orderBy: { lineNo: 'asc' },
    });

    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(paymentBody)
        .expect(200)
    ).body as { lines: { accountId: string; debit: string; credit: string }[]; balanced: boolean };

    expect(preview.balanced).toBe(true);
    expect(preview.lines.length).toBe(jeLines.length); // exactly 2 lines
    for (const jl of jeLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl).toBeDefined();
      expect(pl.debit).toBe(norm(jl.debit));
      expect(pl.credit).toBe(norm(jl.credit));
    }
    // RECEIPT: cash (1-1000) debited, AR control (1-1200) credited.
    expect(preview.lines.find((l) => l.accountId === acc['1-1000'])!.debit).toBe('400000.0000');
    expect(preview.lines.find((l) => l.accountId === acc['1-1200'])!.credit).toBe('400000.0000');
  });

  it('rejects a RECEIPT allocation that references a purchase bill (422)', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({ nature: 'PAYMENT', direction: 'RECEIPT', cashAccountId: acc['1-1000'],
        allocations: [{ purchaseBillId: randomUUID(), amount: '100000' }] })
      .expect(422);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json journal-preview -t PAYMENT`
Expected: FAIL — the DTO rejects `nature: 'PAYMENT'` (currently `@IsIn(['SALE','PURCHASE'])`) → 422 on the parity test's preview call, or 400 shape errors.

- [ ] **Step 3: Widen the request DTO with the payment body**

Replace `src/invoicing/dto/preview-journal-entry.dto.ts` with:

```ts
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaxableLineDto } from '../../tax/dto/calculate-tax.dto';
import { AllocationDto } from './create-payment.dto';

export type PreviewNature = 'SALE' | 'PURCHASE' | 'PAYMENT';

/** Preview a document's journal entry, discriminated by `nature`:
 *  SALE/PURCHASE use the /tax/calculate shape; PAYMENT uses the payment shape. */
export class PreviewJournalEntryDto {
  @ApiProperty({ enum: ['SALE', 'PURCHASE', 'PAYMENT'] })
  @IsIn(['SALE', 'PURCHASE', 'PAYMENT'])
  nature!: PreviewNature;

  // --- SALE | PURCHASE ---
  @ApiPropertyOptional({ format: 'uuid', description: 'Required for SALE/PURCHASE' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature !== 'PAYMENT')
  @IsUUID()
  settlementAccountId?: string;

  @ApiPropertyOptional({ type: [TaxableLineDto], description: 'Required for SALE/PURCHASE' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature !== 'PAYMENT')
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines?: TaxableLineDto[];

  // --- PAYMENT ---
  @ApiPropertyOptional({ enum: ['RECEIPT', 'DISBURSEMENT'], description: 'Required for PAYMENT' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsIn(['RECEIPT', 'DISBURSEMENT'])
  direction?: 'RECEIPT' | 'DISBURSEMENT';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for PAYMENT' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsUUID()
  cashAccountId?: string;

  @ApiPropertyOptional({ type: [AllocationDto], description: 'Required for PAYMENT' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}
```

- [ ] **Step 4: Add the payment derivation to the service**

Edit `src/invoicing/journal-preview.service.ts`. Update the imports and add the `paymentLines` branch:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxService } from '../tax/tax.service';
import { PostingService } from '../ledger/posting/posting.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { Money } from '../common/money/money';
import { findControlAccountId } from './document-helpers';
import { PAYMENT_TARGETS, buildPaymentLines, AllocationInput } from './payment-targets';
import { toPreview, JournalPreview, PreviewSourceLine } from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';

@Injectable()
export class JournalPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
    private readonly posting: PostingService,
  ) {}

  async preview(dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    const lines =
      dto.nature === 'PAYMENT' ? await this.paymentLines(dto) : await this.taxedLines(dto);
    const accounts = await this.posting.resolvePostableAccounts(lines.map((l) => l.accountId));
    return toPreview(lines, accounts);
  }

  /** SALE/PURCHASE: reuse TaxService.calculate — the exact derivation the post path uses. */
  private async taxedLines(dto: PreviewJournalEntryDto): Promise<PreviewSourceLine[]> {
    const calc = await this.tax.calculate({
      nature: dto.nature as 'SALE' | 'PURCHASE',
      settlementAccountId: dto.settlementAccountId!,
      lines: dto.lines!.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        taxCodeIds: l.taxCodeIds,
      })),
    });
    return calc.journalLines;
  }

  /** PAYMENT: reuse buildPaymentLines + control-account-by-role — the exact
   *  derivation PaymentsService.post uses. The many allocations collapse into the
   *  single 2-line cash<->control entry for their total, exactly as posting does. */
  private async paymentLines(dto: PreviewJournalEntryDto): Promise<PreviewSourceLine[]> {
    const target = PAYMENT_TARGETS[dto.direction!];
    let total = Money.zero();
    for (const a of dto.allocations! as AllocationInput[]) {
      // Same allocation type-shape check as loadTarget (no DB read needed for the JE shape).
      if (!target.allocId(a) || target.otherId(a))
        throw new ValidationFailedError(
          `A ${dto.direction!.toLowerCase()} allocation must reference a ${target.label}`,
          {},
        );
      const amt = Money.of(a.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError('Allocation amount must be positive', {});
      total = total.add(amt);
    }
    const controlId = await findControlAccountId(this.prisma, target.controlRole);
    return buildPaymentLines(target, dto.cashAccountId!, controlId, total.toPersistence());
  }
}
```

- [ ] **Step 5: Typecheck, then run the full preview e2e**

Run: `npm run typecheck && npx jest --config ./test/jest-e2e.json journal-preview`
Expected: PASS (7 tests — 5 taxed from Task 4 + 2 payment).

- [ ] **Step 6: Commit**

```bash
git add src/invoicing/dto/preview-journal-entry.dto.ts src/invoicing/journal-preview.service.ts test/journal-preview.e2e-spec.ts
git commit -m "feat(invoicing): journal preview payment path (cash<->control)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Regenerate OpenAPI + full verify

Regenerates the exported OpenAPI (the shape-guard test requires named 2xx DTOs — satisfied by `JournalPreviewResponseDto`) and runs the whole gate.

**Files:**
- Modify: `docs/api/openapi.json` (generated)

**Interfaces:**
- Consumes: everything above.
- Produces: updated `docs/api/openapi.json`; green `npm run verify`.

- [ ] **Step 1: Regenerate the OpenAPI document**

Run: `npm run openapi:export`
Expected: builds, writes `docs/api/openapi.json` including `POST /v1/journal-entries/preview` with `JournalPreviewResponseDto`.

- [ ] **Step 2: Run the full verification gate**

Run: `npm run verify`
Expected: `typecheck` clean, `lint:ci` clean, and `test:cov:all` green — the **merged** nyc gate stays ≥ 90/86/90/90 (the new service/controller are e2e-covered; the pure projection is unit-covered). The unit jest floor (31/31/27/31) stays green (glue is thin; projection carries the logic). If lint reports formatting, run `npm run lint` (auto-fixes) and re-run.

> Note: if the unit `test:cov` global dips below floor, do **not** add mock-theater unit tests for the glue — confirm the merged gate is green (the real merge gate) and that the drop is only the two thin glue files; the repo's policy treats integration glue as e2e/merged-covered.

- [ ] **Step 3: Commit**

```bash
git add docs/api/openapi.json
git commit -m "docs(openapi): export journal-entries/preview endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Report the final contracts to the frontend**

Summarize back (for the `accounting-client` team):
- **Task 1:** no new query params — `?q=` already existed; it now *additionally* matches partner `code` (alongside partner `name` and each document's own ref fields: `invoiceRef` / `billRef`+`vendorInvoiceNo` / `ref`). Same `{data,total,limit,offset}` envelope, same enum/money conventions. The FE can delete its page-scoped `applySearch` filter and the "search on this page" hint.
- **Task 2:** `POST /v1/journal-entries/preview` (bearer auth, `200`, no `Idempotency-Key`), body discriminated by `nature`:
  - `SALE` / `PURCHASE`: `{ nature, settlementAccountId, lines:[{accountId, amount, taxCodeIds}] }` (identical to `/tax/calculate`).
  - `PAYMENT`: `{ nature:"PAYMENT", direction:"RECEIPT"|"DISBURSEMENT", cashAccountId, allocations:[{salesInvoiceId?|purchaseBillId?, amount}] }`.
  - Response: `{ lines:[{accountId, accountCode, accountName, debit, credit}], totalDebit, totalCredit, balanced }` (all money 4-dp strings; inactive side `"0.0000"`).
  - Errors: `422` for invalid/non-postable account, unknown/inactive tax code, non-positive settlement (withholding ≥ gross), missing AR/AP control account, or a wrong-type payment allocation. `400` for malformed body.
  - Deviation from the proposal: PAYMENT uses its own body (the proposed `{settlementAccountId, lines}` cannot represent a payment's cash↔control entry); deeper payment-allocation checks (partner-match / POSTED / outstanding) are enforced at post time, not in the preview.

---

## Self-Review

**Spec coverage:**
- Task 1 partner-`code` search → Task 1. ✓ (name/ref/vendorInvoiceNo matching + filtered `total` + short-`q`-absent already shipped; verified in findings.)
- Deferred partners/accounts/tax-codes `q` → intentionally out of scope (spec §"Deferred"). ✓
- Preview endpoint, discriminated body, reuse of post derivation → Tasks 3-5. ✓
- Shared account validation = "same errors a post would" → Task 2 `resolvePostableAccounts` (the exact method the post path uses). ✓
- code/name enrichment, 4dp, `"0.0000"` non-active side → Task 3 `toPreview`. ✓
- Read-only (no writes / no idempotency / no period/SoD/closed-year) → Task 4 read-only e2e; service never opens a `$transaction`. ✓
- "preview can't lie" post-vs-preview diff → Task 4 (invoice), Task 5 (payment). ✓
- Validation parity (bad account, unknown tax code, wrong-type allocation) → Tasks 4-5. ✓
- Named response DTOs + openapi regen → Task 4 DTO + Task 6. ✓
- Payment deeper-allocation checks are a documented non-goal → Task 6 report. ✓

**Placeholder scan:** No TBD/TODO; every code + test block is complete; commands have expected output. ✓

**Type consistency:** `toPreview(lines, accounts)` / `PreviewSourceLine` / `JournalPreview` consistent across Tasks 3-5. `resolvePostableAccounts(ids: string[]): Promise<Map<string, Account>>` defined in Task 2, consumed in Tasks 4-5. `calc.journalLines` elements are `{accountId, debit?, credit?}` = `PreviewSourceLine`. `buildPaymentLines(...)` returns `PaymentJournalLine[]` = `{accountId, debit?, credit?}` = `PreviewSourceLine`. `AllocationDto` ≡ `AllocationInput` structurally. Controller returns `Promise<JournalPreview>` (structurally the response DTO; `@ApiOkResponse` drives swagger). ✓
