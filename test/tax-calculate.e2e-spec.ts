import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { TaxService, CalculatedLine } from '../src/tax/tax.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Tax calculate (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(UsersService).create({
      email: 'v@tax.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@tax.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
  }, 120_000);

  afterAll(() => cleanup());

  const findLine = (
    lines: { accountId: string; debit?: string; credit?: string }[],
    accountId: string,
  ) => lines.find((l) => l.accountId === accountId)!;

  it('rejects more than 100 lines with 400', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: Array.from({ length: 101 }, () => ({
          accountId: acc['4-1000'],
          amount: '1000',
          taxCodeIds: [],
        })),
      })
      .expect(400);
  });

  it('purchase: DPP 1,000,000 + PPN Masukan 11% + PPh 23 payable 2% → balanced', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines: [
          {
            accountId: acc['5-2000'],
            amount: '1000000',
            taxCodeIds: [code['PPN-IN-11'], code['PPH23-PAY']],
          },
        ],
      })
      .expect(200);
    const body = res.body as {
      subtotal: string;
      settlementAmount: string;
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.settlementAmount).toBe('1090000.0000');
    expect(findLine(body.journalLines, acc['1-1400']).debit).toBe(
      '110000.0000',
    );
    expect(findLine(body.journalLines, acc['2-1200']).credit).toBe(
      '20000.0000',
    );
    expect(findLine(body.journalLines, acc['2-1000']).credit).toBe(
      '1090000.0000',
    );
    const d = body.journalLines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const c = body.journalLines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(d).toBe(c);
  });

  it('sale: DPP 1,000,000 + PPN Keluaran 11% + customer withholds PPh 23 2% → balanced', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          {
            accountId: acc['4-1000'],
            amount: '1000000',
            taxCodeIds: [code['PPN-OUT-11'], code['PPH23-PRE']],
          },
        ],
      })
      .expect(200);
    const body = res.body as {
      settlementAmount: string;
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(body.settlementAmount).toBe('1090000.0000');
    expect(findLine(body.journalLines, acc['1-1200']).debit).toBe(
      '1090000.0000',
    );
    expect(findLine(body.journalLines, acc['2-1100']).credit).toBe(
      '110000.0000',
    );
    expect(findLine(body.journalLines, acc['1-1500']).debit).toBe('20000.0000');
  });

  it('rejects a PPN_INPUT code on a SALE (422 kind-vs-nature)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          {
            accountId: acc['4-1000'],
            amount: '500000',
            taxCodeIds: [code['PPN-IN-11']],
          },
        ],
      })
      .expect(422);
  });

  it('rounds tax once per code across lines sharing it (per-aggregate rounding)', async () => {
    // Two lines of 333,333 sharing PPN-IN-11: aggregate 666,666 × 11% = 73,332.96 → 73,333.
    // Per-line rounding would give 36,667 + 36,667 = 73,334 — proving once-per-code.
    const res = await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines: [
          {
            accountId: acc['5-2000'],
            amount: '333333',
            taxCodeIds: [code['PPN-IN-11']],
          },
          {
            accountId: acc['5-2000'],
            amount: '333333',
            taxCodeIds: [code['PPN-IN-11']],
          },
        ],
      })
      .expect(200);
    const body = res.body as {
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(findLine(body.journalLines, acc['1-1400']).debit).toBe('73333.0000');
  });

  it('handles a tax-free transaction (no codes) → settlement equals subtotal, balanced', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines: [{ accountId: acc['5-2000'], amount: '750000', taxCodeIds: [] }],
      })
      .expect(200);
    const body = res.body as {
      subtotal: string;
      settlementAmount: string;
      taxes: unknown[];
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(body.taxes).toHaveLength(0);
    expect(body.settlementAmount).toBe(body.subtotal);
    expect(findLine(body.journalLines, acc['2-1000']).credit).toBe(
      '750000.0000',
    );
    expect(findLine(body.journalLines, acc['5-2000']).debit).toBe(
      '750000.0000',
    );
  });

  it('rejects a tax code repeated within a single line (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines: [
          {
            accountId: acc['5-2000'],
            amount: '1000000',
            taxCodeIds: [code['PPN-IN-11'], code['PPN-IN-11']],
          },
        ],
      })
      .expect(422);
  });

  it('rejects a transaction whose withholding drives settlement <= 0 (422)', async () => {
    // Two PPH_PAYABLE codes at 99% each → withholding 1,980,000 on a 1,000,000 base.
    const taxCodes = app.get(TaxCodesService);
    const utangPph = acc['2-1200']; // CREDIT-normal, valid for PPH_PAYABLE
    const hi1 = await taxCodes.create({
      code: 'PPH-HI-1',
      name: 'Hi 1',
      kind: 'PPH_PAYABLE',
      rate: '0.99',
      taxAccountId: utangPph,
    });
    const hi2 = await taxCodes.create({
      code: 'PPH-HI-2',
      name: 'Hi 2',
      kind: 'PPH_PAYABLE',
      rate: '0.99',
      taxAccountId: utangPph,
    });
    await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines: [
          {
            accountId: acc['5-2000'],
            amount: '1000000',
            taxCodeIds: [hi1.id, hi2.id],
          },
        ],
      })
      .expect(422);
  });

  it('always balances for random valid purchase transactions (property test)', async () => {
    const tax = app.get(TaxService);
    for (let i = 0; i < 50; i++) {
      const nLines = 1 + (i % 4);
      const lines = Array.from({ length: nLines }, (_, j) => ({
        accountId: acc['5-2000'],
        amount: String(1000 + ((i * 37 + j * 911) % 9_000_000)),
        taxCodeIds:
          (i + j) % 2 === 0
            ? [code['PPN-IN-11'], code['PPH23-PAY']]
            : [code['PPN-IN-11']],
      }));
      const result = await tax.calculate({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines,
      });
      const d = result.journalLines.reduce(
        (s: number, l: CalculatedLine) => s + Number(l.debit ?? 0),
        0,
      );
      const c = result.journalLines.reduce(
        (s: number, l: CalculatedLine) => s + Number(l.credit ?? 0),
        0,
      );
      expect(d).toBeCloseTo(c, 4);
    }
  });
});
