# Collapse the Sales/Purchase Document Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the two ~95% mirror-image services (`SalesInvoicesService`, `PurchaseBillsService`) into one deep `TaxedDocumentService` driven by a typed `DocumentDescriptor`, with `SALE` and `PURCHASE` as two adapters.

**Architecture:** A new stateless `TaxedDocumentService` owns the single-sourced body (validation ordering, messages, line Money-math, orchestration, the draft lock, presenter). Each existing service becomes a thin adapter that builds a strongly-typed `DocumentDescriptor` and delegates every method. Full Prisma typing preserved (no `any`); controllers/routes/DTOs unchanged.

**Tech Stack:** NestJS 11, Prisma 7 (`PrismaService.client`), decimal.js via the `Money` value object, Jest (unit + e2e against testcontainers).

**Spec:** `docs/superpowers/specs/2026-06-19-collapse-document-mirror-design.md`

## Global Constraints

- **No `any` / no erased Prisma typing.** Every closure stays typed. (Hard requirement from the spec.)
- **No behavior change.** Error messages preserved **byte-for-byte** (see Task 1's `documentMessages`).
- **HTTP contracts unchanged:** `/v1/sales-invoices`, `/v1/purchase-bills` routes, request/response DTOs, role guards, idempotency, pagination envelopes. Do not touch the controllers or DTOs.
- **Payments out of scope.** Do not touch `payments.service.ts` / `payments.controller.ts`.
- **Reuse existing seams, do not reinvent:** `DocumentPostingService`, `DocumentLifecycleService`, `findControlAccountId`, `taxableLines`, `listPaginated`, `trigramSearch`, `serializeMoney`, `Money`.
- **Lint gate:** `npm run lint:ci` runs `eslint … --max-warnings 0`. Zero warnings.
- **Coverage gate (the one CI enforces):** `npm run test:e2e:cov` collects coverage from `src/**` and enforces **global 84/62/84/84** (statements/branches/functions/lines). The unit `npm run test` runs **without** coverage. So: the new orchestration in `TaxedDocumentService` is covered by the **existing** sales/purchase e2e specs once both services delegate to it (Tasks 3–4); the unit tests in Task 1 pin the pure logic. Full coverage is verified in Task 5.
- **Branch:** `feat/collapse-document-mirror` (already created and checked out).
- **All money values are 4-decimal strings.** `Money.of` accepts only `string | Decimal`, never a JS number.

> **Note on the spec:** the spec §9/§4 parenthetical references the unit floor "22/18/18/22". The floor CI actually enforces is the **e2e** gate (84/62/84/84) above; the unit floor only runs under `test:cov`, which is not in `verify` or CI. Behavior of the plan is unchanged — the new code is covered by the existing e2e plus the Task 1 unit tests.

---

## File Structure

**Create**
- `src/invoicing/document-descriptor.ts` — all shared types: `DocumentRow`, `DocumentLineRow`, `DocumentLineInput`, `DocumentLineCreateData`, `DocumentTotals`, `DocumentCreateCommon`, `DocumentUpdateCommon`, `DocumentListWhere`, `DocumentLabels`, `CreateDocumentInput`, `UpdateDocumentInput`, `DocumentDescriptor<TRow,TCreate,TUpdate>`.
- `src/invoicing/document-presenter.ts` — pure functions: `presentDocument`, `buildLineCreateData`, `documentMessages`, `partnerKind`.
- `src/invoicing/document-presenter.spec.ts` — unit tests for the pure functions.
- `src/invoicing/taxed-document.service.ts` — the deep module.
- `CONTEXT.md` (repo root) — domain term "taxed trade document".

**Modify**
- `src/ledger/document-lifecycle.service.ts` — `export` the `SoftDeletableModel` type.
- `src/invoicing/sales-invoices.service.ts` — reduce to a thin adapter.
- `src/invoicing/purchase-bills.service.ts` — reduce to a thin adapter.
- `src/invoicing/invoicing.module.ts` — register `TaxedDocumentService`.

**Unchanged (do not touch):** both controllers, all DTOs, `document-posting.service.ts`, `document-helpers.ts`, `payments.*`, the e2e specs.

---

## Task 1: Shared types + pure presenter/line-builder/messages

**Files:**
- Create: `src/invoicing/document-descriptor.ts`
- Create: `src/invoicing/document-presenter.ts`
- Test: `src/invoicing/document-presenter.spec.ts`

**Interfaces:**
- Produces:
  - Types in `document-descriptor.ts` (consumed by Tasks 2–4).
  - `presentDocument<T extends DocumentRow>(doc: T): T & { outstanding: string; paymentStatus: string }`
  - `buildLineCreateData(lines: DocumentLineInput[]): DocumentLineCreateData[]`
  - `documentMessages(l: DocumentLabels): { partnerInactive, notFound, onlyDraftEdit, notADraft, noLongerDraft, onlyPostedVoid, voidWithPaymentsFirst, voidWithPayments, alreadyReversed, notPosted, defaultDescription(id) }`
  - `partnerKind(flag: 'isCustomer' | 'isVendor'): 'customer' | 'vendor'`

- [ ] **Step 1: Create the shared types file**

Create `src/invoicing/document-descriptor.ts`:

```ts
import { AccountRole, DocumentStatus, Prisma } from '@prisma/client';
import { LedgerTx } from '../ledger/posting/posting.service';
import { PostedDocContext } from './document-posting.service';
import { SoftDeletableModel } from '../ledger/document-lifecycle.service';

/** A document line as read back from the DB (Decimal money columns). */
export interface DocumentLineRow {
  lineNo?: number;
  description: string;
  accountId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  amount: Prisma.Decimal;
  taxCodeIds: string[];
}

/** Structural shape every taxed-document row shares; lets presentDocument stay generic. */
export interface DocumentRow {
  id: string;
  status: DocumentStatus;
  partnerId: string;
  date: Date;
  dueDate: Date | null;
  description: string | null;
  createdBy: string;
  journalEntryId: string | null;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  withholdingTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  lines?: DocumentLineRow[];
}

/** A document line as supplied by a caller (4dp strings). */
export interface DocumentLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}

/** A line ready for a Prisma nested create. */
export interface DocumentLineCreateData {
  lineNo: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxCodeIds: string[];
}

export interface CreateDocumentInput {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: DocumentLineInput[];
  createdBy: string;
}

export interface UpdateDocumentInput {
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: DocumentLineInput[];
}

export interface DocumentTotals {
  subtotal: string;
  taxTotal: string;
  withholdingTotal: string;
  total: string;
}

/** Common create-row data the shared module computes once; the descriptor's
 *  createRow merges any type-specific delta (e.g. vendorInvoiceNo). */
export interface DocumentCreateCommon extends DocumentTotals {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  createdBy: string;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentUpdateCommon extends DocumentTotals {
  date: Date;
  dueDate: Date | null;
  description: string | null;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentListWhere {
  partnerId?: string;
  status?: DocumentStatus;
}

/** The label-bearing subset of a descriptor used to build error messages. */
export interface DocumentLabels {
  noun: string; // 'invoice' | 'bill'
  label: string; // 'Sales invoice' | 'Purchase bill'
  article: 'a' | 'an';
  partnerFlag: 'isCustomer' | 'isVendor';
}

/** The typed adapter to one document type's Prisma delegate. */
export interface DocumentDescriptor<
  TRow extends DocumentRow,
  TCreate extends CreateDocumentInput,
  TUpdate extends UpdateDocumentInput,
> extends DocumentLabels {
  nature: 'SALE' | 'PURCHASE';
  controlRole: AccountRole;
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
  documentType: string; // 'INV' | 'BILL'
  table: 'sales_invoices' | 'purchase_bills';
  trigramColumns: string[];
  model: SoftDeletableModel;
  findById(id: string): Promise<TRow | null>;
  page(a: {
    where: DocumentListWhere;
    limit: number;
    offset: number;
  }): Promise<{ rows: TRow[]; total: number }>;
  hydrate(ids: string[]): Promise<TRow[]>;
  createRow(common: DocumentCreateCommon, input: TCreate): Promise<TRow>;
  updateRow(
    tx: LedgerTx,
    id: string,
    common: DocumentUpdateCommon,
    input: TUpdate,
    existing: TRow,
  ): Promise<void>;
  finalizePosted(
    tx: LedgerTx,
    id: string,
    ctx: PostedDocContext,
    postedBy: string,
  ): Promise<void>;
  markVoid(tx: LedgerTx, id: string): Promise<void>;
}
```

> This file imports `SoftDeletableModel` from `document-lifecycle.service`, which is not exported yet — Task 2 Step 1 adds the `export`. Until then `tsc` will error on that import; that is expected and resolved in Task 2. Do not run `tsc` to "verify" Task 1 until Step 5's targeted unit run, which compiles only the spec + presenter graph.

- [ ] **Step 2: Write the failing unit tests**

Create `src/invoicing/document-presenter.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import {
  presentDocument,
  buildLineCreateData,
  documentMessages,
  partnerKind,
} from './document-presenter';
import { DocumentRow, DocumentLabels } from './document-descriptor';

const D = (v: string) => new Prisma.Decimal(v);

function row(total: string, amountPaid: string, lines?: DocumentRow['lines']): DocumentRow {
  return {
    id: 'd1',
    status: 'POSTED',
    partnerId: 'p1',
    date: new Date('2026-01-01T00:00:00Z'),
    dueDate: null,
    description: null,
    createdBy: 'u1',
    journalEntryId: 'je1',
    subtotal: D('900'),
    taxTotal: D('100'),
    withholdingTotal: D('0'),
    total: D(total),
    amountPaid: D(amountPaid),
    lines,
  };
}

const SALES: DocumentLabels = {
  noun: 'invoice',
  label: 'Sales invoice',
  article: 'an',
  partnerFlag: 'isCustomer',
};
const PURCHASE: DocumentLabels = {
  noun: 'bill',
  label: 'Purchase bill',
  article: 'a',
  partnerFlag: 'isVendor',
};

describe('presentDocument', () => {
  it('UNPAID when nothing is paid', () => {
    const out = presentDocument(row('1000', '0'));
    expect(out.outstanding).toBe('1000.0000');
    expect(out.paymentStatus).toBe('UNPAID');
    expect(out.total).toBe('1000.0000');
    expect(out.amountPaid).toBe('0.0000');
  });

  it('PARTIAL when 0 < paid < total', () => {
    const out = presentDocument(row('1000', '400'));
    expect(out.outstanding).toBe('600.0000');
    expect(out.paymentStatus).toBe('PARTIAL');
  });

  it('PAID when paid equals total', () => {
    const out = presentDocument(row('1000', '1000'));
    expect(out.outstanding).toBe('0.0000');
    expect(out.paymentStatus).toBe('PAID');
  });

  it('PAID (negative outstanding) when over-paid', () => {
    const out = presentDocument(row('1000', '1200'));
    expect(out.outstanding).toBe('-200.0000');
    expect(out.paymentStatus).toBe('PAID');
  });

  it('serializes nested line money fields to 4dp strings', () => {
    const out = presentDocument(
      row('1000', '0', [
        {
          lineNo: 1,
          description: 'x',
          accountId: 'a1',
          quantity: D('2'),
          unitPrice: D('500'),
          amount: D('1000'),
          taxCodeIds: [],
        },
      ]),
    );
    expect(out.lines).toEqual([
      {
        lineNo: 1,
        description: 'x',
        accountId: 'a1',
        quantity: '2.0000',
        unitPrice: '500.0000',
        amount: '1000.0000',
        taxCodeIds: [],
      },
    ]);
  });
});

describe('buildLineCreateData', () => {
  it('maps quantity*unitPrice to a 4dp amount and assigns 1-based lineNo', () => {
    expect(
      buildLineCreateData([
        { description: 'x', accountId: 'a1', quantity: '3', unitPrice: '1000.5', taxCodeIds: ['t1'] },
      ]),
    ).toEqual([
      {
        lineNo: 1,
        description: 'x',
        accountId: 'a1',
        quantity: '3',
        unitPrice: '1000.5',
        amount: '3001.5000',
        taxCodeIds: ['t1'],
      },
    ]);
  });
});

describe('partnerKind', () => {
  it('maps the partner flag to a noun', () => {
    expect(partnerKind('isCustomer')).toBe('customer');
    expect(partnerKind('isVendor')).toBe('vendor');
  });
});

describe('documentMessages parity', () => {
  it('reproduces every sales-invoice string byte-for-byte', () => {
    const m = documentMessages(SALES);
    expect(m.partnerInactive).toBe('Partner is not an active customer');
    expect(m.notFound).toBe('Sales invoice not found');
    expect(m.onlyDraftEdit).toBe('Only a DRAFT invoice can be edited');
    expect(m.notADraft).toBe('Invoice is not a draft');
    expect(m.noLongerDraft).toBe('Invoice is no longer a draft');
    expect(m.onlyPostedVoid).toBe('Only a POSTED invoice can be voided');
    expect(m.voidWithPaymentsFirst).toBe(
      'Cannot void an invoice with payments; void the payments first',
    );
    expect(m.voidWithPayments).toBe('Cannot void an invoice with payments');
    expect(m.alreadyReversed).toBe('Invoice journal entry was already reversed');
    expect(m.notPosted).toBe('Invoice is not posted');
    expect(m.defaultDescription('abc')).toBe('Sales invoice abc');
  });

  it('reproduces every purchase-bill string byte-for-byte', () => {
    const m = documentMessages(PURCHASE);
    expect(m.partnerInactive).toBe('Partner is not an active vendor');
    expect(m.notFound).toBe('Purchase bill not found');
    expect(m.onlyDraftEdit).toBe('Only a DRAFT bill can be edited');
    expect(m.notADraft).toBe('Bill is not a draft');
    expect(m.noLongerDraft).toBe('Bill is no longer a draft');
    expect(m.onlyPostedVoid).toBe('Only a POSTED bill can be voided');
    expect(m.voidWithPaymentsFirst).toBe(
      'Cannot void a bill with payments; void the payments first',
    );
    expect(m.voidWithPayments).toBe('Cannot void a bill with payments');
    expect(m.alreadyReversed).toBe('Bill journal entry was already reversed');
    expect(m.notPosted).toBe('Bill is not posted');
    expect(m.defaultDescription('abc')).toBe('Purchase bill abc');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/invoicing/document-presenter.spec.ts`
Expected: FAIL — `Cannot find module './document-presenter'`.

- [ ] **Step 4: Implement the pure module**

Create `src/invoicing/document-presenter.ts`:

```ts
import { Money } from '../common/money/money';
import { serializeMoney } from '../common/money/serialize-money';
import {
  DocumentRow,
  DocumentLineInput,
  DocumentLineCreateData,
  DocumentLabels,
} from './document-descriptor';

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function partnerKind(flag: 'isCustomer' | 'isVendor'): 'customer' | 'vendor' {
  return flag === 'isCustomer' ? 'customer' : 'vendor';
}

/** Every user-facing message for a taxed trade document, byte-for-byte identical
 *  to the strings the two services produced before the collapse. */
export function documentMessages(l: DocumentLabels) {
  const N = cap(l.noun);
  return {
    partnerInactive: `Partner is not an active ${partnerKind(l.partnerFlag)}`,
    notFound: `${l.label} not found`,
    onlyDraftEdit: `Only a DRAFT ${l.noun} can be edited`,
    notADraft: `${N} is not a draft`,
    noLongerDraft: `${N} is no longer a draft`,
    onlyPostedVoid: `Only a POSTED ${l.noun} can be voided`,
    voidWithPaymentsFirst: `Cannot void ${l.article} ${l.noun} with payments; void the payments first`,
    voidWithPayments: `Cannot void ${l.article} ${l.noun} with payments`,
    alreadyReversed: `${N} journal entry was already reversed`,
    notPosted: `${N} is not posted`,
    defaultDescription: (id: string) => `${l.label} ${id}`,
  };
}

/** Map caller line inputs to Prisma nested-create rows (amount = qty*unitPrice, 4dp). */
export function buildLineCreateData(lines: DocumentLineInput[]): DocumentLineCreateData[] {
  return lines.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    accountId: l.accountId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: Money.of(l.unitPrice).multiply(l.quantity).toPersistence(),
    taxCodeIds: l.taxCodeIds,
  }));
}

/** Shape an API response: 4dp money strings + derived outstanding/paymentStatus.
 *  Generic over any taxed-document row. */
export function presentDocument<T extends DocumentRow>(
  doc: T,
): T & { outstanding: string; paymentStatus: string } {
  const total = Money.of(doc.total.toString());
  const paid = Money.of(doc.amountPaid.toString());
  const outstanding = total.subtract(paid);
  const paymentStatus = paid.isZero()
    ? 'UNPAID'
    : outstanding.isZero() || outstanding.isNegative()
      ? 'PAID'
      : 'PARTIAL';
  const lines = (doc as DocumentRow & { lines?: Record<string, unknown>[] }).lines;
  return {
    ...serializeMoney(doc, ['subtotal', 'taxTotal', 'withholdingTotal', 'total', 'amountPaid']),
    ...(lines
      ? { lines: lines.map((l) => serializeMoney(l, ['quantity', 'unitPrice', 'amount'])) }
      : {}),
    outstanding: outstanding.toPersistence(),
    paymentStatus,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/invoicing/document-presenter.spec.ts`
Expected: PASS — 8 passed.

- [ ] **Step 6: Lint the new files**

Run: `npx eslint src/invoicing/document-descriptor.ts src/invoicing/document-presenter.ts src/invoicing/document-presenter.spec.ts --max-warnings 0`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add src/invoicing/document-descriptor.ts src/invoicing/document-presenter.ts src/invoicing/document-presenter.spec.ts
git commit -m "feat(invoicing): shared document types + pure presenter/messages

Pure logic for the taxed-document collapse: presentDocument,
buildLineCreateData, and a documentMessages builder whose unit tests
pin the sales/purchase error strings byte-for-byte.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The deep TaxedDocumentService

**Files:**
- Modify: `src/ledger/document-lifecycle.service.ts:7` (export the type)
- Create: `src/invoicing/taxed-document.service.ts`
- Modify: `src/invoicing/invoicing.module.ts`

**Interfaces:**
- Consumes: all types from `document-descriptor.ts`; `presentDocument`/`buildLineCreateData`/`documentMessages` from `document-presenter.ts`; `DocumentPostingService.{computeTotals,post}`; `DocumentLifecycleService.{softDeleteDraft,reverseWithGuard}`; `findControlAccountId`, `taxableLines`; `listPaginated`, `trigramSearch`.
- Produces: `TaxedDocumentService` with `getById`, `createDraft`, `update`, `listPage`, `deleteDraft`, `post`, `void` — each generic `<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(spec: DocumentDescriptor<R,C,U>, …)`. Consumed by Tasks 3–4.

- [ ] **Step 1: Export `SoftDeletableModel`**

In `src/ledger/document-lifecycle.service.ts`, change line 7 from `type SoftDeletableModel = {` to:

```ts
export type SoftDeletableModel = {
```

(No other change to that file.)

- [ ] **Step 2: Create the deep module**

Create `src/invoicing/taxed-document.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import { LedgerTx } from '../ledger/posting/posting.service';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated } from '../common/pagination/paginated';
import { taxableLines, findControlAccountId } from './document-helpers';
import {
  DocumentDescriptor,
  DocumentRow,
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentListWhere,
} from './document-descriptor';
import {
  presentDocument,
  buildLineCreateData,
  documentMessages,
} from './document-presenter';

type Spec<
  R extends DocumentRow,
  C extends CreateDocumentInput,
  U extends UpdateDocumentInput,
> = DocumentDescriptor<R, C, U>;

interface ListQuery {
  q?: string;
  partnerId?: string;
  status?: DocumentStatus;
  limit?: number;
  offset?: number;
}

/**
 * The single writer/reader of a "taxed trade document" (sales invoice /
 * purchase bill): documents that run through the tax engine and post to an
 * AR/AP control account. Stateless — every method takes a typed
 * DocumentDescriptor. Owns validation ordering, messages, line Money-math,
 * the draft lock, and orchestration; the descriptor supplies the typed
 * per-model Prisma calls.
 */
@Injectable()
export class TaxedDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async getById<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    id: string,
  ): Promise<R> {
    const row = await spec.findById(id);
    if (!row) throw new NotFoundDomainError(documentMessages(spec).notFound, { id });
    return row;
  }

  async createDraft<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    input: C,
  ): Promise<R> {
    const m = documentMessages(spec);
    const partner = await this.partners.findById(input.partnerId);
    if (!partner[spec.partnerFlag] || !partner.isActive)
      throw new ValidationFailedError(m.partnerInactive, { partnerId: input.partnerId });
    const settlementId = await findControlAccountId(this.prisma, spec.controlRole);
    const totals = await this.docPosting.computeTotals(
      spec.nature,
      settlementId,
      taxableLines(input.lines),
    );
    const common = {
      partnerId: input.partnerId,
      date: input.date,
      dueDate: input.dueDate,
      description: input.description,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      withholdingTotal: totals.withholdingTotal,
      total: totals.total,
      createdBy: input.createdBy,
      lines: { create: buildLineCreateData(input.lines) },
    };
    return spec.createRow(common, input);
  }

  async update<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    id: string,
    input: U,
  ): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'DRAFT')
      throw new ValidationFailedError(m.onlyDraftEdit, { id, status: row.status });
    const nextLines =
      input.lines ??
      (row.lines ?? []).map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        taxCodeIds: l.taxCodeIds,
      }));
    const settlementId = await findControlAccountId(this.prisma, spec.controlRole);
    const totals = await this.docPosting.computeTotals(
      spec.nature,
      settlementId,
      taxableLines(nextLines),
    );
    const common = {
      date: input.date ?? row.date,
      dueDate: input.dueDate ?? row.dueDate,
      description: input.description ?? row.description,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      withholdingTotal: totals.withholdingTotal,
      total: totals.total,
      lines: { create: buildLineCreateData(nextLines) },
    };
    await this.prisma.client.$transaction(async (tx) => {
      await spec.updateRow(tx as unknown as LedgerTx, id, common, input, row);
    });
    return this.getById(spec, id);
  }

  listPage<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    q: ListQuery,
  ) {
    const filters: Prisma.Sql[] = [];
    if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
    if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
    const where: DocumentListWhere = { partnerId: q.partnerId, status: q.status };
    return listPaginated({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r: R) => presentDocument(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: spec.table,
          alias: 't',
          ownColumns: spec.trigramColumns,
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name'],
          },
          filters,
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) => spec.hydrate(ids),
      page: ({ limit, offset }) => spec.page({ where, limit, offset }),
    });
  }

  deleteDraft<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    id: string,
    deletedBy: string,
  ): Promise<void> {
    return this.lifecycle.softDeleteDraft(spec.model, id, deletedBy, spec.noun);
  }

  async post<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    id: string,
    postedBy: string,
  ): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'DRAFT')
      throw new ValidationFailedError(m.notADraft, { id, status: row.status });
    const partner = await this.partners.findById(row.partnerId);
    if (!partner[spec.partnerFlag] || !partner.isActive)
      throw new ValidationFailedError(m.partnerInactive, { partnerId: row.partnerId });
    const settlementId = await findControlAccountId(this.prisma, spec.controlRole);

    await this.docPosting.post(
      {
        nature: spec.nature,
        settlementAccountId: settlementId,
        date: row.date,
        description: row.description ?? m.defaultDescription(id),
        sourceType: spec.sourceType,
        sourceId: id,
        createdBy: row.createdBy,
        postedBy,
        documentType: spec.documentType,
        lines: taxableLines(row.lines ?? []),
      },
      (tx) => this.lockDraft(tx, spec, id),
      (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),
    );
    return this.getById(spec, id);
  }

  async void<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    spec: Spec<R, C, U>,
    id: string,
    voidedBy: string,
  ): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'POSTED')
      throw new ValidationFailedError(m.onlyPostedVoid, { id, status: row.status });
    if (!Money.of(row.amountPaid.toString()).isZero())
      throw new ConflictDomainError(m.voidWithPaymentsFirst, { id });
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: row.journalEntryId!,
      reversedBy: voidedBy,
      alreadyReversedMessage: m.alreadyReversed,
      notPostedMessage: m.notPosted,
      lock: (tx) => this.lockForVoid(tx, spec, id),
      applyInTx: async (tx, locked) => {
        if (Number(locked.amount_paid) !== 0)
          throw new ConflictDomainError(m.voidWithPayments, { id });
        await spec.markVoid(tx, id);
      },
    });
    return this.getById(spec, id);
  }

  /** FOR UPDATE draft lock built from the descriptor's constant table identifier. */
  private async lockDraft<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    tx: LedgerTx,
    spec: Spec<R, C, U>,
    id: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT status FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (rows.length === 0 || rows[0].status !== 'DRAFT')
      throw new ValidationFailedError(documentMessages(spec).noLongerDraft, { id });
  }

  /** FOR UPDATE lock for void: returns status + amount_paid for the in-tx re-check. */
  private async lockForVoid<R extends DocumentRow, C extends CreateDocumentInput, U extends UpdateDocumentInput>(
    tx: LedgerTx,
    spec: Spec<R, C, U>,
    id: string,
  ): Promise<{ status: string; amount_paid: string } | undefined> {
    const rows = await tx.$queryRaw<{ status: string; amount_paid: string }[]>(
      Prisma.sql`SELECT status, amount_paid FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    return rows[0];
  }
}
```

- [ ] **Step 3: Register the provider**

In `src/invoicing/invoicing.module.ts`, add the import and provider. Add to the imports block:

```ts
import { TaxedDocumentService } from './taxed-document.service';
```

And add `TaxedDocumentService` as the first entry of the `providers` array (before `DocumentNumberService`). Do **not** add it to `exports` (only the two facade services are exported).

- [ ] **Step 4: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS (exit 0, no output). This resolves the `SoftDeletableModel` import from Task 1 and verifies the deep module + descriptor types compile end-to-end.

> If `tsc` errors inside `lockDraft`/`lockForVoid` on `tx.$queryRaw(Prisma.sql\`…\`)`, the call form is correct for a `Prisma.Sql` argument; re-check the import of `Prisma` from `@prisma/client`.

- [ ] **Step 5: Lint and run the unit suite (no behavior wired yet)**

Run: `npm run lint:ci`
Expected: clean (exit 0).

Run: `npm run test`
Expected: PASS — all existing unit tests plus Task 1's `document-presenter` tests. (The deep module is not yet exercised; that happens in Tasks 3–4 via e2e.)

- [ ] **Step 6: Commit**

```bash
git add src/ledger/document-lifecycle.service.ts src/invoicing/taxed-document.service.ts src/invoicing/invoicing.module.ts
git commit -m "feat(invoicing): add deep TaxedDocumentService

Single-sourced body for taxed trade documents (create/update/list/
delete/post/void/getById), driven by a typed DocumentDescriptor. The
draft FOR UPDATE lock is owned here, built from the descriptor's
constant table identifier. Not yet wired to callers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Convert SalesInvoicesService to a thin adapter

**Files:**
- Modify: `src/invoicing/sales-invoices.service.ts` (full replacement)
- Test (regression net, unmodified): `test/sales-invoices.e2e-spec.ts`

**Interfaces:**
- Consumes: `TaxedDocumentService`; `DocumentDescriptor`, `DocumentRow`, `DocumentStatus`; `presentDocument`.
- Produces: `SalesInvoicesService` with the same public methods the controller already calls — `createDraft(input)`, `update(id, input)`, `getById(id)`, `listPage(q)`, `deleteDraft(id, deletedBy)`, `post(id, postedBy)`, `void(id, voidedBy)`, `present(row)` — plus the exported input types `CreateInvoiceInput`, `UpdateInvoiceInput`, `InvoiceLineInput`.

> **This task is the verification point for the spec's known Prisma-typing risk.** If `createRow`'s `data: common` or `updateRow`'s `data: common` fails to typecheck against the Prisma model's create/update input, apply the fallback in Step 3 (assemble the row explicitly inside the closure). Do not reach for `any`.

- [ ] **Step 1: Replace the service with a thin adapter**

Replace the entire contents of `src/invoicing/sales-invoices.service.ts` with:

```ts
import { Injectable } from '@nestjs/common';
import { DocumentStatus, SalesInvoice, SalesInvoiceLine } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxedDocumentService } from './taxed-document.service';
import { presentDocument } from './document-presenter';
import { DocumentDescriptor } from './document-descriptor';

export type SalesInvoiceRow = SalesInvoice & { lines?: SalesInvoiceLine[] };

export interface InvoiceLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}
export interface CreateInvoiceInput {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: InvoiceLineInput[];
  createdBy: string;
}
export interface UpdateInvoiceInput {
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: InvoiceLineInput[];
}

@Injectable()
export class SalesInvoicesService {
  private readonly spec: DocumentDescriptor<SalesInvoiceRow, CreateInvoiceInput, UpdateInvoiceInput>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: TaxedDocumentService,
  ) {
    this.spec = {
      noun: 'invoice',
      label: 'Sales invoice',
      article: 'an',
      partnerFlag: 'isCustomer',
      nature: 'SALE',
      controlRole: 'AR_CONTROL',
      sourceType: 'SALES_INVOICE',
      documentType: 'INV',
      table: 'sales_invoices',
      trigramColumns: ['invoice_ref', 'description'],
      model: this.prisma.client.salesInvoice,
      findById: (id) =>
        this.prisma.client.salesInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      page: async ({ where, limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.salesInvoice.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.salesInvoice.count({ where }),
        ]);
        return { rows, total };
      },
      hydrate: (ids) =>
        this.prisma.client.salesInvoice.findMany({ where: { id: { in: ids } } }),
      createRow: (common) =>
        this.prisma.client.salesInvoice.create({
          data: common,
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      updateRow: async (tx, id, common) => {
        await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });
        await tx.salesInvoice.update({ where: { id }, data: common });
      },
      finalizePosted: async (tx, id, ctx, postedBy) => {
        await tx.salesInvoice.update({
          where: { id },
          data: {
            status: 'POSTED',
            invoiceNumber: ctx.number,
            invoiceRef: ctx.ref,
            fiscalYear: ctx.fiscalYear,
            journalEntryId: ctx.entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: ctx.totals.subtotal,
            taxTotal: ctx.totals.taxTotal,
            withholdingTotal: ctx.totals.withholdingTotal,
            total: ctx.totals.total,
          },
        });
      },
      markVoid: async (tx, id) => {
        await tx.salesInvoice.update({ where: { id }, data: { status: 'VOID' } });
      },
    };
  }

  createDraft(input: CreateInvoiceInput): Promise<SalesInvoiceRow> {
    return this.docs.createDraft(this.spec, input);
  }
  update(id: string, input: UpdateInvoiceInput): Promise<SalesInvoiceRow> {
    return this.docs.update(this.spec, id, input);
  }
  getById(id: string): Promise<SalesInvoiceRow> {
    return this.docs.getById(this.spec, id);
  }
  listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }) {
    return this.docs.listPage(this.spec, q);
  }
  deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.docs.deleteDraft(this.spec, id, deletedBy);
  }
  post(id: string, postedBy: string): Promise<SalesInvoiceRow> {
    return this.docs.post(this.spec, id, postedBy);
  }
  void(id: string, voidedBy: string): Promise<SalesInvoiceRow> {
    return this.docs.void(this.spec, id, voidedBy);
  }
  present(row: SalesInvoiceRow) {
    return presentDocument(row);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

**If `data: common` errors** in `createRow`/`updateRow` (the known Prisma nested-write risk), apply this fallback — replace the two closures so the row is assembled explicitly inside the typed call:

```ts
createRow: ({ lines, ...scalars }) =>
  this.prisma.client.salesInvoice.create({
    data: { ...scalars, lines: { create: lines.create } },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  }),
updateRow: async (tx, id, { lines, ...scalars }) => {
  await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });
  await tx.salesInvoice.update({
    where: { id },
    data: { ...scalars, lines: { create: lines.create } },
  });
},
```

Re-run `npm run typecheck` until it passes. (Same fallback applies to Task 4's bill closures.)

- [ ] **Step 3: Lint**

Run: `npm run lint:ci`
Expected: clean.

- [ ] **Step 4: Run the sales-invoices e2e spec (regression net)**

Run: `npx jest --config ./test/jest-e2e.json sales-invoices`
Expected: PASS — all `sales-invoices.e2e-spec.ts` tests green (create/post/void/list/search, 403/422 error paths).

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/sales-invoices.service.ts
git commit -m "refactor(invoicing): SalesInvoicesService delegates to TaxedDocumentService

Sales invoices become a thin typed adapter: build a DocumentDescriptor,
delegate every method. Behavior unchanged; sales-invoices e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Convert PurchaseBillsService to a thin adapter

**Files:**
- Modify: `src/invoicing/purchase-bills.service.ts` (full replacement)
- Test (regression net, unmodified): `test/purchase-bills.e2e-spec.ts`

**Interfaces:**
- Consumes: same as Task 3.
- Produces: `PurchaseBillsService` with the controller's public methods + `CreateBillInput` (incl. `vendorInvoiceNo?`), `UpdateBillInput` (incl. `vendorInvoiceNo?`), `BillLineInput`.

- [ ] **Step 1: Replace the service with a thin adapter**

Replace the entire contents of `src/invoicing/purchase-bills.service.ts` with:

```ts
import { Injectable } from '@nestjs/common';
import { DocumentStatus, PurchaseBill, PurchaseBillLine } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxedDocumentService } from './taxed-document.service';
import { presentDocument } from './document-presenter';
import { DocumentDescriptor } from './document-descriptor';

export type PurchaseBillRow = PurchaseBill & { lines?: PurchaseBillLine[] };

export interface BillLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}
export interface CreateBillInput {
  partnerId: string;
  vendorInvoiceNo?: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: BillLineInput[];
  createdBy: string;
}
export interface UpdateBillInput {
  vendorInvoiceNo?: string;
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: BillLineInput[];
}

@Injectable()
export class PurchaseBillsService {
  private readonly spec: DocumentDescriptor<PurchaseBillRow, CreateBillInput, UpdateBillInput>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: TaxedDocumentService,
  ) {
    this.spec = {
      noun: 'bill',
      label: 'Purchase bill',
      article: 'a',
      partnerFlag: 'isVendor',
      nature: 'PURCHASE',
      controlRole: 'AP_CONTROL',
      sourceType: 'PURCHASE_BILL',
      documentType: 'BILL',
      table: 'purchase_bills',
      trigramColumns: ['bill_ref', 'vendor_invoice_no', 'description'],
      model: this.prisma.client.purchaseBill,
      findById: (id) =>
        this.prisma.client.purchaseBill.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      page: async ({ where, limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.purchaseBill.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.purchaseBill.count({ where }),
        ]);
        return { rows, total };
      },
      hydrate: (ids) =>
        this.prisma.client.purchaseBill.findMany({ where: { id: { in: ids } } }),
      createRow: (common, input) =>
        this.prisma.client.purchaseBill.create({
          data: { ...common, vendorInvoiceNo: input.vendorInvoiceNo },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      updateRow: async (tx, id, common, input, existing) => {
        await tx.purchaseBillLine.deleteMany({ where: { purchaseBillId: id } });
        await tx.purchaseBill.update({
          where: { id },
          data: {
            ...common,
            vendorInvoiceNo: input.vendorInvoiceNo ?? existing.vendorInvoiceNo,
          },
        });
      },
      finalizePosted: async (tx, id, ctx, postedBy) => {
        await tx.purchaseBill.update({
          where: { id },
          data: {
            status: 'POSTED',
            billNumber: ctx.number,
            billRef: ctx.ref,
            fiscalYear: ctx.fiscalYear,
            journalEntryId: ctx.entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: ctx.totals.subtotal,
            taxTotal: ctx.totals.taxTotal,
            withholdingTotal: ctx.totals.withholdingTotal,
            total: ctx.totals.total,
          },
        });
      },
      markVoid: async (tx, id) => {
        await tx.purchaseBill.update({ where: { id }, data: { status: 'VOID' } });
      },
    };
  }

  createDraft(input: CreateBillInput): Promise<PurchaseBillRow> {
    return this.docs.createDraft(this.spec, input);
  }
  update(id: string, input: UpdateBillInput): Promise<PurchaseBillRow> {
    return this.docs.update(this.spec, id, input);
  }
  getById(id: string): Promise<PurchaseBillRow> {
    return this.docs.getById(this.spec, id);
  }
  listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }) {
    return this.docs.listPage(this.spec, q);
  }
  deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.docs.deleteDraft(this.spec, id, deletedBy);
  }
  post(id: string, postedBy: string): Promise<PurchaseBillRow> {
    return this.docs.post(this.spec, id, postedBy);
  }
  void(id: string, voidedBy: string): Promise<PurchaseBillRow> {
    return this.docs.void(this.spec, id, voidedBy);
  }
  present(row: PurchaseBillRow) {
    return presentDocument(row);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `data` errors on the nested write, apply the Task 3 Step 2 fallback adapted to `purchaseBill`/`purchaseBillLine`, keeping the `vendorInvoiceNo` field.)

- [ ] **Step 3: Lint**

Run: `npm run lint:ci`
Expected: clean.

- [ ] **Step 4: Run the purchase-bills e2e spec (regression net)**

Run: `npx jest --config ./test/jest-e2e.json purchase-bills`
Expected: PASS — all `purchase-bills.e2e-spec.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/purchase-bills.service.ts
git commit -m "refactor(invoicing): PurchaseBillsService delegates to TaxedDocumentService

Purchase bills become a thin typed adapter; vendorInvoiceNo is carried
by its create/update closures. Behavior unchanged; purchase-bills e2e
green. Completes the sales/purchase mirror collapse.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CONTEXT.md + full verification

**Files:**
- Create: `CONTEXT.md` (repo root)

**Interfaces:** none (documentation + final gate).

- [ ] **Step 1: Create CONTEXT.md with the new domain term**

Create `CONTEXT.md` at the repo root:

```markdown
# Domain Context

Ubiquitous terms used in this codebase, beyond the accounting glossary in
`docs/runbooks/domain-glossary.md`. Keep entries short; link code where useful.

## Taxed trade document

A document that runs through the tax engine (`TaxService`) and posts to an
AR/AP **control account** via `DocumentPostingService` — i.e. a **sales invoice**
or a **purchase bill**. Payments are *not* taxed trade documents (they settle
documents and carry no tax lines).

The shared behavior of taxed trade documents (create/update/list/delete/post/void
and presentation) lives in one deep module, `TaxedDocumentService`
(`src/invoicing/taxed-document.service.ts`), driven by a typed
`DocumentDescriptor` (`src/invoicing/document-descriptor.ts`). `SALE` and
`PURCHASE` are the two descriptor adapters, built by `SalesInvoicesService` and
`PurchaseBillsService` respectively.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm run verify`
Expected: PASS — `typecheck` (exit 0), `lint:ci` (clean), `test` (all unit specs pass), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84). The deep module is now exercised by both document e2e specs, so its lines/branches are covered.

> If `test:e2e:cov` fails **only** on the branch threshold (62%), inspect the coverage report for an unhit branch in `taxed-document.service.ts` (e.g. an error path not exercised by the existing specs). Net lines decreased versus the two old services, so a regression here is unlikely; if it occurs, the gap is a pre-existing untested branch surfaced by consolidation — report it rather than adding speculative code.

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): add 'taxed trade document' term

Records the concept boundary behind TaxedDocumentService (sales invoice +
purchase bill; excludes payments) introduced by the mirror collapse.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Final sanity diff**

Run: `git diff --stat main`
Expected: new files (`document-descriptor.ts`, `document-presenter.ts`, `document-presenter.spec.ts`, `taxed-document.service.ts`, `CONTEXT.md`, the design spec) plus net **reductions** in `sales-invoices.service.ts` and `purchase-bills.service.ts` (each ~370 → ~110 lines), a one-word change in `document-lifecycle.service.ts`, and a one-line provider add in `invoicing.module.ts`. No changes to controllers, DTOs, or `payments.*`.

---

## Self-Review

**1. Spec coverage**
- §5 module shape (deep `TaxedDocumentService` + two thin adapters) → Tasks 2, 3, 4. ✓
- §6 `DocumentDescriptor` interface → Task 1 Step 1 (`document-descriptor.ts`). ✓
- §7 data flow (createDraft/post/void, lock owned by the module from `spec.table`) → Task 2. ✓
- §8 error handling + byte-for-byte message parity → `documentMessages` (Task 1) with parity unit tests; consumed in Task 2. ✓
- §9 testing (unit pure logic + e2e net) → Task 1 unit tests; Tasks 3–4 e2e; Task 5 full coverage gate. ✓
- §10 migration sequencing → Tasks 1→5 mirror the six steps (CONTEXT.md folded into Task 5). ✓
- §11 risks (Prisma nested-write typing) → Task 3 Step 2 fallback (and Task 4). ✓
- §3 scope: payments untouched, controllers/DTOs untouched → stated in Global Constraints + Task 5 Step 4 diff check. ✓
- §1 `vendorInvoiceNo` asymmetry → Task 4's `createRow`/`updateRow` closures. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Every code step shows complete code; every test step shows assertions; fallback code is spelled out. ✓

**3. Type consistency:** `DocumentDescriptor<TRow,TCreate,TUpdate>` generic order is identical across Tasks 1–4. `documentMessages(DocumentLabels)` keys used in Task 2 (`partnerInactive`, `notADraft`, `onlyDraftEdit`, `onlyPostedVoid`, `voidWithPaymentsFirst`, `voidWithPayments`, `alreadyReversed`, `notPosted`, `notFound`, `noLongerDraft`, `defaultDescription`) all match Task 1's returned object and its parity tests. `finalizePosted(tx,id,ctx,postedBy)` 4-arg shape is consistent between the interface (Task 1), the deep `post` call site (Task 2: `(ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy)`), and both adapters (Tasks 3–4). `SoftDeletableModel` exported in Task 2 Step 1 and consumed by `document-descriptor.ts` `model` field. `PostedDocContext` provides `tx`, `number`, `ref`, `entry`, `fiscalYear`, `totals` (matches `document-posting.service.ts`). ✓

No issues found.
