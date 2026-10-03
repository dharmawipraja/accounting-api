import { Injectable } from '@nestjs/common';
import { Prisma, TaxInvoiceStatus } from '@prisma/client';
import { LedgerTx, PrismaService } from '../common/prisma/prisma.service';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import { dateRange } from '../common/dates/query-dates';
import { businessDate } from '../common/dates/business-date';
import { CompanyService } from '../company/company.service';
import {
  assembleTaxInvoice,
  CoretaxProblem,
  CoretaxVatCode,
  FakturTaxInvoice,
  renderTaxInvoiceBulk,
  sellerProblems,
} from './faktur';
import { MAX_EXPORT_INVOICES } from './dto';

/** Document tables carrying Coretax metadata — constant literals, never
 *  user input (safe for Prisma.raw). */
type MetaTable =
  | 'sales_invoices'
  | 'purchase_bills'
  | 'sales_credit_notes'
  | 'purchase_debit_notes';

const LABEL: Record<MetaTable, string> = {
  sales_invoices: 'Sales invoice',
  purchase_bills: 'Purchase bill',
  sales_credit_notes: 'Sales credit note',
  purchase_debit_notes: 'Purchase debit note',
};

interface LockedDoc {
  status: string;
  withholding_total?: string;
  tax_invoice_status?: TaxInvoiceStatus;
  tax_invoice_number?: string | null;
  tax_invoice_date?: Date | null;
  trx_code?: string | null;
}

export interface ReferenceInput {
  number: string | null;
  date: string | null;
}

export interface TaxInvoiceInput {
  taxInvoiceNumber?: string | null;
  taxInvoiceDate?: string | null;
  status?: TaxInvoiceStatus;
  trxCode?: string | null;
}

/**
 * Coretax (DJP) support: the Faktur Pajak Keluaran XML export and the
 * metadata recorded after Coretax processed it (NSFP, bukti potong, retur
 * reference). Never touches amounts or the ledger: every write here changes
 * metadata columns only, on POSTED (or VOID) documents.
 */
@Injectable()
export class CoretaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
  ) {}

  /** The import file for POSTED invoices dated [from, to] with PPN Output;
   *  422 listing every problem instead of an invalid file. Read-only. */
  async exportFakturKeluaran(q: {
    from: string;
    to: string;
    status?: 'NONE' | 'EXPORTED';
  }): Promise<{ xml: string; count: number }> {
    const { from, to } = dateRange(q.from, q.to, 366);
    const settings = await this.company.get();
    const seller = {
      npwp: settings.npwp,
      nitkuSuffix: settings.nitkuSuffix,
      isPkp: settings.isPkp,
      defaultItemType: settings.coretaxDefaultItemType,
      defaultItemCode: settings.coretaxDefaultItemCode,
      defaultUnitCode: settings.coretaxDefaultUnitCode,
    };
    const problems: CoretaxProblem[] = sellerProblems(seller);

    const invoices = await this.prisma.client.salesInvoice.findMany({
      where: {
        status: 'POSTED',
        date: { gte: from, lte: to },
        taxInvoiceStatus: q.status ?? { in: ['NONE', 'EXPORTED'] },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, partner: true },
      orderBy: [{ date: 'asc' }, { invoiceNumber: 'asc' }],
      take: MAX_EXPORT_INVOICES + 1,
    });
    if (invoices.length > MAX_EXPORT_INVOICES)
      throw new ValidationFailedError(
        `More than ${MAX_EXPORT_INVOICES} invoices in the range; export a shorter range`,
        { from: q.from, to: q.to, max: MAX_EXPORT_INVOICES },
      );

    const vatCodes = await this.vatCodes(
      invoices.flatMap((i) => i.lines.flatMap((l) => l.taxCodeIds)),
    );
    const taxInvoices: FakturTaxInvoice[] = [];
    for (const inv of invoices) {
      const r = assembleTaxInvoice(
        {
          id: inv.id,
          invoiceRef: inv.invoiceRef,
          date: inv.date,
          trxCode: inv.trxCode,
          taxTotal: inv.taxTotal.toString(),
          buyer: {
            name: inv.partner.name,
            npwp: inv.partner.npwp,
            buyerDocumentType: inv.partner.buyerDocumentType,
            buyerDocumentNumber: inv.partner.buyerDocumentNumber,
            nitkuSuffix: inv.partner.nitkuSuffix,
            country: inv.partner.country,
            address: inv.partner.address,
            email: inv.partner.email,
          },
          lines: inv.lines.map((l) => ({
            lineNo: l.lineNo,
            description: l.description,
            quantity: l.quantity.toString(),
            unitPrice: l.unitPrice.toString(),
            discountAmount: l.discountAmount.toString(),
            amount: l.amount.toString(),
            taxCodeIds: l.taxCodeIds,
            coretaxItemType: l.coretaxItemType,
            coretaxItemCode: l.coretaxItemCode,
            coretaxUnitCode: l.coretaxUnitCode,
          })),
        },
        seller,
        vatCodes,
      );
      if ('skip' in r) continue;
      if ('taxInvoice' in r) taxInvoices.push(r.taxInvoice);
      else problems.push(...r.problems);
    }
    if (problems.length > 0)
      throw new ValidationFailedError(
        'Coretax export blocked: fix the listed master data first',
        { reason: 'CORETAX_DATA_INCOMPLETE', problems },
      );
    if (taxInvoices.length === 0)
      throw new ValidationFailedError(
        'No POSTED invoice with PPN Output to export in the range',
        { reason: 'NOTHING_TO_EXPORT', from: q.from, to: q.to },
      );
    return {
      xml: renderTaxInvoiceBulk(seller.npwp!, taxInvoices),
      count: taxInvoices.length,
    };
  }

  /** PPN Output codes by id — soft-deleted ones included (a posted invoice
   *  keeps the code it was taxed with). */
  private async vatCodes(ids: string[]): Promise<Map<string, CoretaxVatCode>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.client.$queryRaw<
      {
        id: string;
        code: string;
        rate: string;
        dpp_nilai_lain: boolean;
        coretax_vat_rate: string | null;
      }[]
    >`
      SELECT id, code, rate::text AS rate, dpp_nilai_lain,
             coretax_vat_rate::text AS coretax_vat_rate
      FROM tax_codes
      WHERE id = ANY(${unique}::text[]) AND kind = 'PPN_OUTPUT'`;
    return new Map(
      rows.map((r) => [
        r.id,
        {
          // A tombstoned code reads '<code>#deleted-<id>'; show the code.
          code: r.code.replace(/#deleted-.*$/, ''),
          rate: r.rate,
          dppNilaiLain: r.dpp_nilai_lain,
          coretaxVatRate: r.coretax_vat_rate,
        },
      ]),
    );
  }

  /** Mark invoices EXPORTED after the file was uploaded to Coretax. All or
   *  nothing: 422 listing ids that are not POSTED / not NONE|EXPORTED. */
  async markExported(ids: string[]): Promise<{ updated: number }> {
    const unique = [...new Set(ids)];
    return this.prisma.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; status: string; tax_invoice_status: string }[]
      >`
        SELECT id, status::text, tax_invoice_status::text FROM sales_invoices
        WHERE id = ANY(${unique}::text[]) AND deleted_at IS NULL
        ORDER BY id FOR UPDATE`;
      const found = new Map(rows.map((r) => [r.id, r]));
      const invalid = unique
        .map((id) => ({ id, row: found.get(id) }))
        .filter(
          ({ row }) =>
            !row ||
            row.status !== 'POSTED' ||
            !['NONE', 'EXPORTED'].includes(row.tax_invoice_status),
        )
        .map(({ id, row }) => ({
          id,
          status: row?.status ?? null,
          taxInvoiceStatus: row?.tax_invoice_status ?? null,
        }));
      if (invalid.length > 0)
        throw new ValidationFailedError(
          'Only POSTED invoices with taxInvoiceStatus NONE or EXPORTED can be marked exported',
          { invalid },
        );
      const { count } = await tx.salesInvoice.updateMany({
        where: { id: { in: unique } },
        data: { taxInvoiceStatus: 'EXPORTED', coretaxExportedAt: new Date() },
      });
      return { updated: count };
    });
  }

  /** Record the faktur Coretax issued (NSFP + date) or its later status
   *  (CANCELLED…) on a POSTED / VOID invoice. 409 on an NSFP already on
   *  another live invoice. */
  async recordTaxInvoice(id: string, input: TaxInvoiceInput): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const row = await this.lockPostedOrVoid(tx, 'sales_invoices', id, {
        extra: Prisma.sql`, tax_invoice_status::text AS tax_invoice_status,
          tax_invoice_number, tax_invoice_date, trx_code`,
      });
      const number =
        input.taxInvoiceNumber === undefined
          ? (row.tax_invoice_number ?? null)
          : input.taxInvoiceNumber;
      const date =
        input.taxInvoiceDate === undefined
          ? (row.tax_invoice_date ?? null)
          : input.taxInvoiceDate === null
            ? null
            : businessDate(input.taxInvoiceDate);
      const status =
        input.status ??
        (input.taxInvoiceNumber ? 'APPROVED' : row.tax_invoice_status!);
      if (status === 'APPROVED' && (!number || !date))
        throw new ValidationFailedError(
          'An APPROVED faktur needs taxInvoiceNumber and taxInvoiceDate',
          { id, taxInvoiceNumber: number, taxInvoiceDate: date },
        );
      if (
        input.trxCode !== undefined &&
        input.trxCode !== row.trx_code &&
        row.tax_invoice_status === 'APPROVED'
      )
        throw new ValidationFailedError(
          'trxCode cannot change once the faktur is APPROVED',
          { id },
        );
      try {
        await tx.salesInvoice.update({
          where: { id },
          data: {
            taxInvoiceNumber: number,
            taxInvoiceDate: date,
            taxInvoiceStatus: status,
            trxCode: input.trxCode,
          },
        });
      } catch (err) {
        mapUniqueViolation(
          err,
          'This tax invoice number (NSFP) is already recorded on another invoice',
          { taxInvoiceNumber: number },
        );
      }
    });
  }

  /** Bukti potong PPh on a POSTED invoice (customer withheld, PPH_PREPAID)
   *  or bill (we withheld, PPH_PAYABLE): only when the document carries that
   *  withholding (withholdingTotal > 0 — the engine's PPh bucket, whose kind
   *  is fixed by the document nature). */
  async recordWithholdingSlip(
    table: 'sales_invoices' | 'purchase_bills',
    id: string,
    input: ReferenceInput,
  ): Promise<void> {
    const ref = referenceData(input);
    await this.prisma.transaction(async (tx) => {
      const row = await this.lockPostedOrVoid(tx, table, id, {
        extra: Prisma.sql`, withholding_total::text AS withholding_total`,
        postedOnly: true,
      });
      if (!(Number(row.withholding_total) > 0))
        throw new ValidationFailedError(
          table === 'sales_invoices'
            ? 'This invoice has no PPh withheld by the customer (PPH_PREPAID)'
            : 'This bill has no PPh withheld (PPH_PAYABLE)',
          { id, reason: 'NO_WITHHOLDING' },
        );
      const data = {
        withholdingSlipNumber: ref.number,
        withholdingSlipDate: ref.date,
      };
      if (table === 'sales_invoices')
        await tx.salesInvoice.update({ where: { id }, data });
      else await tx.purchaseBill.update({ where: { id }, data });
    });
  }

  /** Coretax retur reference on a POSTED / VOID credit or debit note. */
  async recordRetur(
    table: 'sales_credit_notes' | 'purchase_debit_notes',
    id: string,
    input: ReferenceInput,
  ): Promise<void> {
    const ref = referenceData(input);
    await this.prisma.transaction(async (tx) => {
      await this.lockPostedOrVoid(tx, table, id);
      const data = { returNumber: ref.number, returDate: ref.date };
      if (table === 'sales_credit_notes')
        await tx.salesCreditNote.update({ where: { id }, data });
      else await tx.purchaseDebitNote.update({ where: { id }, data });
    });
  }

  /** FOR UPDATE the live document; 404 if missing, 422 if a DRAFT (or, with
   *  postedOnly, anything but POSTED). */
  private async lockPostedOrVoid(
    tx: LedgerTx,
    table: MetaTable,
    id: string,
    opts: { extra?: Prisma.Sql; postedOnly?: boolean } = {},
  ): Promise<LockedDoc> {
    const rows = await tx.$queryRaw<LockedDoc[]>(Prisma.sql`
      SELECT status::text AS status ${opts.extra ?? Prisma.empty}
      FROM ${Prisma.raw(table)}
      WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`);
    if (rows.length === 0)
      throw new NotFoundDomainError(`${LABEL[table]} not found`, { id });
    const ok = opts.postedOnly
      ? rows[0].status === 'POSTED'
      : rows[0].status !== 'DRAFT';
    if (!ok)
      throw new ValidationFailedError(
        `${LABEL[table]} must be ${opts.postedOnly ? 'POSTED' : 'POSTED or VOID'} to record Coretax data`,
        { id, status: rows[0].status },
      );
    return rows[0];
  }
}

/** Both set or both null (clear); 422 otherwise. */
function referenceData(input: ReferenceInput): {
  number: string | null;
  date: Date | null;
} {
  if ((input.number === null) !== (input.date === null))
    throw new ValidationFailedError(
      'number and date are set together (or both null to clear)',
    );
  return {
    number: input.number,
    date: input.date === null ? null : businessDate(input.date),
  };
}
