// src/reporting/ppn-recap.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { BalancesService } from '../ledger/balances/balances.service';
import { POSTED_JE } from '../ledger/balances/posted-entry.sql';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import {
  documentPpnBase,
  fakturTrxCode,
  ledgerTieOut,
  netPpn,
  netResult,
  parseMasa,
  PpnCode,
  PpnLedgerRow,
  signedNote,
  totals,
} from './ppn-recap';

const day = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: { toString(): string }) => v.toString();
const money = (v: { toString(): string }) => Money.of(v.toString()).toString();
const lineInput = (l: {
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  amount: Prisma.Decimal;
  taxCodeIds: string[];
}) => ({
  quantity: str(l.quantity),
  unitPrice: str(l.unitPrice),
  discountAmount: str(l.discountAmount),
  amount: str(l.amount),
  taxCodeIds: l.taxCodeIds,
});

/**
 * Rekap PPN Masa: PPN Keluaran (sales invoices − batal − retur) and PPN
 * Masukan (purchase bills − batal − retur) of one calendar month, the per-
 * document list to reconcile against Coretax, and the tie-out to the PPN
 * accounts in the ledger. Read-only, one REPEATABLE READ snapshot.
 *
 * Void rule (ledger-tied, reproducible): a document counts in the masa of its
 * date; its void (reversal journal, dated voidedOn) counts as `batal` in the
 * masa of voidedOn. Same-month voids therefore net to zero. DJP reports a
 * cancelled faktur in its ORIGINAL masa (pembetulan, PER-03/PJ/2022 /
 * PMK 81/2024) — a cross-month void raises a warning saying so.
 */
@Injectable()
export class PpnRecapService {
  constructor(private readonly balances: BalancesService) {}

  generate(period: string) {
    const masa = parseMasa(period);
    if (!masa)
      throw new ValidationFailedError('period must be a valid YYYY-MM', {
        period,
      });
    return this.balances.snapshot((tx) =>
      this.build(period, masa.from, masa.to, tx),
    );
  }

  // ponytail: no row cap — a recap must be complete; a month of documents is
  // small. Add a cap/pagination if a tenant posts tens of thousands a month.
  private async build(period: string, from: Date, to: Date, tx: LedgerTx) {
    const inMasa = { gte: from, lte: to };
    const docWhere = {
      deletedAt: null,
      status: { in: ['POSTED' as const, 'VOID' as const] },
      OR: [{ date: inMasa }, { voidedOn: inMasa }],
    };
    const lines = { orderBy: { lineNo: 'asc' as const } };
    // Sequential: one connection per transaction.
    const settings = await tx.companySettings.findFirst({
      select: { isPkp: true },
    });
    const codeRows = await tx.$queryRaw<
      {
        id: string;
        code: string;
        kind: PpnCode['kind'];
        rate: string;
        dpp_nilai_lain: boolean;
        coretax_vat_rate: string | null;
        tax_account_id: string;
      }[]
    >`SELECT id, code, kind::text AS kind, rate::text AS rate, dpp_nilai_lain,
               coretax_vat_rate::text AS coretax_vat_rate, tax_account_id
        FROM tax_codes WHERE kind IN ('PPN_OUTPUT', 'PPN_INPUT')`;
    const invoices = await tx.salesInvoice.findMany({
      where: docWhere,
      include: { lines, partner: true },
      orderBy: [{ date: 'asc' }, { invoiceNumber: 'asc' }],
    });
    const bills = await tx.purchaseBill.findMany({
      where: docWhere,
      include: { lines, partner: true },
      orderBy: [{ date: 'asc' }, { billNumber: 'asc' }],
    });
    const cns = await tx.salesCreditNote.findMany({
      where: docWhere,
      include: { lines, partner: true, original: true },
      orderBy: [{ date: 'asc' }, { number: 'asc' }],
    });
    const dns = await tx.purchaseDebitNote.findMany({
      where: docWhere,
      include: { lines, partner: true, original: true },
      orderBy: [{ date: 'asc' }, { number: 'asc' }],
    });

    const codes = new Map<string, PpnCode>(
      codeRows.map((c) => [
        c.id,
        {
          id: c.id,
          // A tombstoned code reads '<code>#deleted-<id>'.
          code: c.code.replace(/#deleted-.*$/, ''),
          kind: c.kind,
          rate: c.rate,
          dppNilaiLain: c.dpp_nilai_lain,
          coretaxVatRate: c.coretax_vat_rate,
        },
      ]),
    );
    const accountsOf = (kind: PpnCode['kind']) =>
      new Set(
        codeRows.filter((c) => c.kind === kind).map((c) => c.tax_account_id),
      );
    const outputAccounts = accountsOf('PPN_OUTPUT');
    const inputAccounts = accountsOf('PPN_INPUT');
    const isIn = (d: Date | null) =>
      d !== null &&
      d.getTime() >= from.getTime() &&
      d.getTime() <= to.getTime();

    // ---------------------------------------------------------- Keluaran
    const keluaranRows = invoices.flatMap((inv) => {
      const base = documentPpnBase(
        inv.lines.map(lineInput),
        codes,
        'PPN_OUTPUT',
      );
      if (!base) return [];
      return [
        {
          row: {
            id: inv.id,
            invoiceRef: inv.invoiceRef,
            date: day(inv.date),
            partnerName: inv.partner.name,
            npwp: inv.partner.npwp,
            buyerDocumentType: inv.partner.buyerDocumentType,
            buyerDocumentNumber: inv.partner.buyerDocumentNumber,
            trxCode: fakturTrxCode(inv.trxCode, base.nilaiLain),
            dpp: base.dpp,
            dppNilaiLain: base.dppNilaiLain,
            ppn: money(inv.taxTotal),
            fakturPpn: base.fakturPpn,
            taxInvoiceNumber: inv.taxInvoiceNumber,
            taxInvoiceStatus: inv.taxInvoiceStatus,
            status: inv.status,
            voidedOn: inv.voidedOn && day(inv.voidedOn),
          },
          dated: isIn(inv.date),
          voided: isIn(inv.voidedOn),
        },
      ];
    });
    const keluaran = keluaranRows.filter((x) => x.dated).map((x) => x.row);
    const batalKeluaran = keluaranRows
      .filter((x) => x.voided)
      .map((x) => x.row);

    const returKeluaran = cns.flatMap((n) => {
      const base = documentPpnBase(n.lines.map(lineInput), codes, 'PPN_OUTPUT');
      if (!base) return [];
      const row = (cancellation: boolean) =>
        signedNote({
          id: n.id,
          ref: n.ref,
          date: day(n.date),
          originalRef: n.original.invoiceRef,
          partnerName: n.partner.name,
          npwp: n.partner.npwp,
          dpp: base.dpp,
          dppNilaiLain: base.dppNilaiLain,
          ppn: money(n.taxTotal),
          returNumber: n.returNumber,
          returDate: n.returDate && day(n.returDate),
          voidedOn: n.voidedOn && day(n.voidedOn),
          cancellation,
        });
      return [
        ...(isIn(n.date) ? [row(false)] : []),
        ...(isIn(n.voidedOn) ? [row(true)] : []),
      ];
    });

    // ----------------------------------------------------------- Masukan
    const masukanRows = bills.flatMap((b) => {
      const base = documentPpnBase(b.lines.map(lineInput), codes, 'PPN_INPUT');
      if (!base) return [];
      return [
        {
          row: {
            id: b.id,
            billRef: b.billRef,
            vendorInvoiceNo: b.vendorInvoiceNo,
            date: day(b.date),
            partnerName: b.partner.name,
            npwp: b.partner.npwp,
            dpp: base.dpp,
            dppNilaiLain: base.dppNilaiLain,
            ppn: money(b.taxTotal),
            status: b.status,
            voidedOn: b.voidedOn && day(b.voidedOn),
          },
          dated: isIn(b.date),
          voided: isIn(b.voidedOn),
        },
      ];
    });
    const masukan = masukanRows.filter((x) => x.dated).map((x) => x.row);
    const batalMasukan = masukanRows.filter((x) => x.voided).map((x) => x.row);

    const returMasukan = dns.flatMap((n) => {
      const base = documentPpnBase(n.lines.map(lineInput), codes, 'PPN_INPUT');
      if (!base) return [];
      const row = (cancellation: boolean) =>
        signedNote({
          id: n.id,
          ref: n.ref,
          date: day(n.date),
          originalRef: n.original.billRef,
          partnerName: n.partner.name,
          npwp: n.partner.npwp,
          dpp: base.dpp,
          dppNilaiLain: base.dppNilaiLain,
          ppn: money(n.taxTotal),
          returNumber: n.returNumber,
          returDate: n.returDate && day(n.returDate),
          voidedOn: n.voidedOn && day(n.voidedOn),
          cancellation,
        });
      return [
        ...(isIn(n.date) ? [row(false)] : []),
        ...(isIn(n.voidedOn) ? [row(true)] : []),
      ];
    });

    // ------------------------------------------------------------ Totals
    const t = {
      ppnKeluaran: totals(keluaran),
      batalKeluaran: totals(batalKeluaran),
      returKeluaran: totals(returKeluaran),
      ppnMasukan: totals(masukan),
      batalMasukan: totals(batalMasukan),
      returMasukan: totals(returMasukan),
    };
    const ppnKeluaranNet = netPpn(
      t.ppnKeluaran,
      t.batalKeluaran,
      t.returKeluaran,
    );
    const ppnMasukanNet = netPpn(t.ppnMasukan, t.batalMasukan, t.returMasukan);

    // ------------------------------------------------------------ Ledger
    const ppnAccounts = [...new Set([...outputAccounts, ...inputAccounts])];
    const ledgerRows =
      ppnAccounts.length === 0
        ? []
        : await tx.$queryRaw<
            {
              journal_entry_id: string;
              entry_ref: string | null;
              date: Date;
              source_type: string;
              origin: string;
              account_id: string;
              account_code: string;
              debit: Prisma.Decimal;
              credit: Prisma.Decimal;
            }[]
          >(Prisma.sql`
            SELECT je.id AS journal_entry_id, je.entry_ref, je.date,
                   je.source_type::text AS source_type,
                   COALESCE(s.source_type, je.source_type)::text AS origin,
                   jl.account_id, a.code AS account_code,
                   SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.journal_entry_id
            JOIN accounts a ON a.id = jl.account_id
            LEFT JOIN journal_entries s ON s.id = je.reversal_of_id
            WHERE ${POSTED_JE}
              AND je.date BETWEEN ${from} AND ${to}
              AND jl.account_id = ANY(${ppnAccounts}::text[])
            GROUP BY je.id, s.source_type, jl.account_id, a.code
            ORDER BY je.date, je.entry_number, a.code`);
    const ledger = ledgerTieOut(
      ledgerRows.map(
        (r): PpnLedgerRow => ({
          journalEntryId: r.journal_entry_id,
          entryRef: r.entry_ref,
          date: day(r.date),
          sourceType: r.source_type,
          origin: r.origin,
          accountId: r.account_id,
          accountCode: r.account_code,
          debit: str(r.debit),
          credit: str(r.credit),
        }),
      ),
      outputAccounts,
      inputAccounts,
    );
    const ties =
      ledger.ppnKeluaran === ppnKeluaranNet &&
      ledger.ppnMasukan === ppnMasukanNet;

    // ---------------------------------------------------------- Warnings
    const isPkp = settings?.isPkp ?? false;
    const warnings: string[] = [];
    if (!isPkp)
      warnings.push(
        'Perusahaan bukan PKP: tidak menerbitkan faktur pajak; rekap ditampilkan apa adanya.',
      );
    const masaOf = (d: string) => d.slice(0, 7);
    for (const r of batalKeluaran)
      if (masaOf(r.date) !== period)
        warnings.push(
          `Faktur ${r.invoiceRef ?? r.id} (${r.date}) dibatalkan ${r.voidedOn}: DJP melaporkan pembatalan faktur pada masa asalnya ${masaOf(r.date)} (pembetulan SPT); rekap ini mencatatnya di masa pembatalan agar sesuai buku besar.`,
        );
    for (const r of batalMasukan)
      if (masaOf(r.date) !== period)
        warnings.push(
          `Tagihan ${r.billRef ?? r.id} (${r.date}) dibatalkan ${r.voidedOn}: PPN Masukan masa ${masaOf(r.date)} mungkin perlu pembetulan SPT.`,
        );
    if (ledger.unreconciledManualEntries.entries.length > 0)
      warnings.push(
        `Ada ${ledger.unreconciledManualEntries.entries.length} jurnal non-dokumen (mis. manual) pada akun PPN di masa ini; tidak termasuk rekap — lihat ledger.unreconciledManualEntries.`,
      );
    if (!ties)
      warnings.push(
        'Rekap dokumen TIDAK sama dengan mutasi akun PPN dari dokumen di buku besar.',
      );

    return {
      period,
      from: day(from),
      to: day(to),
      isPkp,
      ...t,
      ppnKeluaranNet,
      ppnMasukanNet,
      ...netResult(ppnKeluaranNet, ppnMasukanNet),
      fakturs: {
        keluaran,
        batalKeluaran,
        returKeluaran,
        masukan,
        batalMasukan,
        returMasukan,
      },
      ledger: { ...ledger, ties },
      warnings,
    };
  }
}

export type PpnRecap = Awaited<ReturnType<PpnRecapService['generate']>>;
