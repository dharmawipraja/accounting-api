// src/reporting/dto/ppn-recap.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ValidateBy } from 'class-validator';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '../../common/dto/limits';
import { ExportFormatField, type ExportFormat } from '../export/render';
import { parseMasa } from '../ppn-recap';

export class PpnRecapQueryDto {
  @ApiProperty({
    example: '2026-03',
    pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
    description: `Masa pajak (calendar month) YYYY-MM, year ${FISCAL_YEAR_MIN}–${FISCAL_YEAR_MAX}.`,
  })
  @ValidateBy({
    name: 'isMasaPajak',
    validator: {
      validate: (v) => typeof v === 'string' && parseMasa(v) !== null,
      defaultMessage: () =>
        `period must be YYYY-MM with a year in ${FISCAL_YEAR_MIN}–${FISCAL_YEAR_MAX}`,
    },
  })
  period!: string;
  @ExportFormatField() format?: ExportFormat;
}

export class PpnTotalsDto {
  @ApiProperty({ description: 'Number of documents (rows).' }) count!: number;
  @ApiMoney({ description: 'Σ DPP (TaxBase, per-line 2 dp as on the faktur).' })
  dpp!: string;
  @ApiMoney({
    description:
      'Σ DPP Nilai Lain (OtherTaxBase: 11/12 × DPP for dppNilaiLain codes, else DPP).',
  })
  dppNilaiLain!: string;
  @ApiMoney({ description: 'Σ posted PPN (what the ledger carries).' })
  ppn!: string;
}

export class PpnKeluaranRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) invoiceRef!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty() partnerName!: string;
  @ApiProperty({ type: String, nullable: true }) npwp!: string | null;
  @ApiProperty({ enum: ['TIN', 'NATIONAL_ID', 'PASSPORT', 'OTHER'] })
  buyerDocumentType!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'NIK / passport / other ID when not TIN.',
  })
  buyerDocumentNumber!: string | null;
  @ApiProperty({ example: '04' }) trxCode!: string;
  @ApiMoney() dpp!: string;
  @ApiMoney() dppNilaiLain!: string;
  @ApiMoney({ description: 'Posted PPN (ledger).' }) ppn!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Σ faktur VAT as the Coretax XML computes it (per line, 2 dp); may differ from ppn by rounding (≤ 0.5 per code). Null when a code’s Coretax presentation is inconsistent.',
  })
  fakturPpn!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'NSFP' })
  taxInvoiceNumber!: string | null;
  @ApiProperty({ enum: ['NONE', 'EXPORTED', 'APPROVED', 'CANCELLED'] })
  taxInvoiceStatus!: string;
  @ApiProperty({ enum: ['POSTED', 'VOID'] }) status!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  voidedOn!: string | null;
}

export class PpnMasukanRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) billRef!: string | null;
  @ApiProperty({ type: String, nullable: true })
  vendorInvoiceNo!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty() partnerName!: string;
  @ApiProperty({ type: String, nullable: true }) npwp!: string | null;
  @ApiMoney() dpp!: string;
  @ApiMoney({ description: 'Equals dpp (PPN Masukan has no Nilai Lain).' })
  dppNilaiLain!: string;
  @ApiMoney() ppn!: string;
  @ApiProperty({ enum: ['POSTED', 'VOID'] }) status!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  voidedOn!: string | null;
}

export class PpnReturRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) ref!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Original invoice/bill ref.',
  })
  originalRef!: string | null;
  @ApiProperty() partnerName!: string;
  @ApiProperty({ type: String, nullable: true }) npwp!: string | null;
  @ApiMoney({ description: 'Negative on a cancellation row.' }) dpp!: string;
  @ApiMoney() dppNilaiLain!: string;
  @ApiMoney() ppn!: string;
  @ApiProperty({ type: String, nullable: true }) returNumber!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  returDate!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  voidedOn!: string | null;
  @ApiProperty({
    description:
      'True: the note was voided in this masa — the row restores the retur (amounts negated).',
  })
  cancellation!: boolean;
}

export class PpnRecapFaktursDto {
  @ApiProperty({
    type: [PpnKeluaranRowDto],
    description: 'Invoices dated in the masa (incl. ones voided later).',
  })
  keluaran!: PpnKeluaranRowDto[];
  @ApiProperty({
    type: [PpnKeluaranRowDto],
    description: 'Invoices voided in the masa (any date).',
  })
  batalKeluaran!: PpnKeluaranRowDto[];
  @ApiProperty({ type: [PpnReturRowDto] }) returKeluaran!: PpnReturRowDto[];
  @ApiProperty({ type: [PpnMasukanRowDto] }) masukan!: PpnMasukanRowDto[];
  @ApiProperty({ type: [PpnMasukanRowDto] }) batalMasukan!: PpnMasukanRowDto[];
  @ApiProperty({ type: [PpnReturRowDto] }) returMasukan!: PpnReturRowDto[];
}

export class PpnUnreconciledEntryDto {
  @ApiProperty({ format: 'uuid' }) journalEntryId!: string;
  @ApiProperty({ type: String, nullable: true }) entryRef!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ example: 'MANUAL' }) sourceType!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty({ enum: ['KELUARAN', 'MASUKAN'] }) side!: string;
  @ApiMoney({
    description: 'Keluaran: credit − debit; Masukan: debit − credit.',
  })
  amount!: string;
}

export class PpnUnreconciledDto {
  @ApiMoney() ppnKeluaran!: string;
  @ApiMoney() ppnMasukan!: string;
  @ApiProperty({ type: [PpnUnreconciledEntryDto] })
  entries!: PpnUnreconciledEntryDto[];
}

export class PpnLedgerTieDto {
  @ApiMoney({
    description:
      'PPN Output accounts, credit − debit, of sales invoice / credit note journals (and their void reversals) dated in the masa.',
  })
  ppnKeluaran!: string;
  @ApiMoney({
    description:
      'PPN Input accounts, debit − credit, of purchase bill / debit note journals (and their void reversals) dated in the masa.',
  })
  ppnMasukan!: string;
  @ApiProperty({
    type: PpnUnreconciledDto,
    description:
      'Movements from other journals (manual, opening…) on the PPN accounts — not in the recap.',
  })
  unreconciledManualEntries!: PpnUnreconciledDto;
  @ApiProperty({
    description: 'ppnKeluaran = ppnKeluaranNet AND ppnMasukan = ppnMasukanNet.',
  })
  ties!: boolean;
}

export class PpnRecapResponseDto {
  @ApiProperty({ example: '2026-03' }) period!: string;
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiProperty() isPkp!: boolean;
  @ApiProperty({
    type: PpnTotalsDto,
    description: 'Faktur keluaran dated in the masa (gross).',
  })
  ppnKeluaran!: PpnTotalsDto;
  @ApiProperty({
    type: PpnTotalsDto,
    description: 'Invoices voided in the masa (faktur batal).',
  })
  batalKeluaran!: PpnTotalsDto;
  @ApiProperty({
    type: PpnTotalsDto,
    description:
      'Sales credit notes (retur) dated in the masa, minus those voided in it.',
  })
  returKeluaran!: PpnTotalsDto;
  @ApiProperty({
    type: PpnTotalsDto,
    description: 'Purchase bills dated in the masa (gross).',
  })
  ppnMasukan!: PpnTotalsDto;
  @ApiProperty({ type: PpnTotalsDto }) batalMasukan!: PpnTotalsDto;
  @ApiProperty({ type: PpnTotalsDto }) returMasukan!: PpnTotalsDto;
  @ApiMoney({
    description: 'ppnKeluaran.ppn − batalKeluaran.ppn − returKeluaran.ppn',
  })
  ppnKeluaranNet!: string;
  @ApiMoney({
    description: 'ppnMasukan.ppn − batalMasukan.ppn − returMasukan.ppn',
  })
  ppnMasukanNet!: string;
  @ApiMoney({
    description:
      'ppnKeluaranNet − ppnMasukanNet; > 0 kurang bayar, < 0 lebih bayar.',
  })
  net!: string;
  @ApiProperty({ enum: ['KURANG_BAYAR', 'LEBIH_BAYAR', 'NIHIL'] })
  netStatus!: string;
  @ApiProperty({ type: PpnRecapFaktursDto }) fakturs!: PpnRecapFaktursDto;
  @ApiProperty({ type: PpnLedgerTieDto }) ledger!: PpnLedgerTieDto;
  @ApiProperty({ type: [String] }) warnings!: string[];
}
