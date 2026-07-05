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
    await users.create({
      email: 'acct@jp.test',
      password: 'secret123',
      name: 'A',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@jp.test',
      password: 'secret123',
      name: 'B',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@jp.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@jp.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'CUST-JP', name: 'Pelanggan', isCustomer: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const saleBody = () => ({
    nature: 'SALE',
    settlementAccountId: acc['1-1200'], // AR control
    lines: [
      {
        accountId: acc['4-1000'],
        amount: '1000000',
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ],
  });

  it('SALE preview: balanced, enriched with code/name, equals /tax/calculate lines', async () => {
    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as {
      lines: {
        accountId: string;
        accountCode: string;
        accountName: string;
        debit: string;
        credit: string;
      }[];
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
    ).body as {
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
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
        lines: [
          {
            description: 'Jasa',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ],
      })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(server())
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const journalEntryId = (posted.body as { journalEntryId: string })
      .journalEntryId;
    const jeLines = await prisma.client.journalLine.findMany({
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
    const header = await prisma.client.account.findFirst({
      where: { isPostable: false },
    });
    expect(header).not.toBeNull();
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [{ accountId: header!.id, amount: '1000000', taxCodeIds: [] }],
      })
      .expect(422);
  });

  it('rejects an unknown tax code with 422', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          {
            accountId: acc['4-1000'],
            amount: '1000000',
            taxCodeIds: [randomUUID()],
          },
        ],
      })
      .expect(422);
  });
});
