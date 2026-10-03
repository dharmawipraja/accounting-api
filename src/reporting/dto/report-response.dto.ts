// src/reporting/dto/report-response.dto.ts
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class ReportLineDto {
  @ApiProperty({ example: '4-1000' }) code!: string;
  @ApiProperty({ example: 'Pendapatan' }) name!: string;
  @ApiMoney() amount!: string;
}

export class ReportGroupDto {
  @ApiProperty({ example: 'CURRENT_ASSET' }) subtype!: string;
  @ApiProperty({ type: [ReportLineDto] }) lines!: ReportLineDto[];
  @ApiMoney() subtotal!: string;
}

export class ReportSectionDto {
  @ApiProperty({ type: [ReportGroupDto] }) groups!: ReportGroupDto[];
  @ApiMoney() total!: string;
}

/** One account (or synthetic line) in both periods. */
export class VarianceLineDto {
  @ApiProperty({ example: '4-1000' }) code!: string;
  @ApiProperty({ example: 'Pendapatan' }) name!: string;
  @ApiMoney({ description: 'Amount in the main period' }) current!: string;
  @ApiMoney({ description: 'Amount in the comparison period' })
  comparative!: string;
  @ApiMoney({ description: 'current − comparative' }) variance!: string;
}

export class BalanceSheetVarianceLineDto extends VarianceLineDto {
  @ApiProperty({ example: 'CURRENT_ASSET' }) subtype!: string;
}

export class BalanceSheetVarianceDto {
  @ApiMoney() totalAssets!: string;
  @ApiMoney() totalLiabilities!: string;
  @ApiMoney() totalEquity!: string;
  @ApiMoney() currentYearEarnings!: string;
  @ApiMoney() unclosedPriorYearsEarnings!: string;
  @ApiProperty({
    type: [BalanceSheetVarianceLineDto],
    description:
      "Union of both dates' lines keyed by (subtype, code); a line missing on one side counts 0 there. Main-report order, then comparative-only lines.",
  })
  assets!: BalanceSheetVarianceLineDto[];
  @ApiProperty({ type: [BalanceSheetVarianceLineDto] })
  liabilities!: BalanceSheetVarianceLineDto[];
  @ApiProperty({ type: [BalanceSheetVarianceLineDto] })
  equity!: BalanceSheetVarianceLineDto[];
}

export class IncomeStatementVarianceDto {
  @ApiMoney() revenue!: string;
  @ApiMoney() cogs!: string;
  @ApiMoney() grossProfit!: string;
  @ApiMoney() operatingExpense!: string;
  @ApiMoney() operatingProfit!: string;
  @ApiMoney() otherIncome!: string;
  @ApiMoney() otherExpense!: string;
  @ApiMoney() profitBeforeTax!: string;
  @ApiMoney() taxExpense!: string;
  @ApiMoney() netIncome!: string;
  @ApiProperty({
    type: [VarianceLineDto],
    description:
      "Union of both periods' accounts keyed by code; an account missing in one period counts 0 there. Main-period order, then comparative-only accounts. Same for every *Lines field.",
  })
  revenueLines!: VarianceLineDto[];
  @ApiProperty({ type: [VarianceLineDto] }) cogsLines!: VarianceLineDto[];
  @ApiProperty({ type: [VarianceLineDto] })
  operatingExpenseLines!: VarianceLineDto[];
  @ApiProperty({ type: [VarianceLineDto] })
  otherIncomeLines!: VarianceLineDto[];
  @ApiProperty({ type: [VarianceLineDto] })
  otherExpenseLines!: VarianceLineDto[];
  @ApiProperty({ type: [VarianceLineDto] })
  taxExpenseLines!: VarianceLineDto[];
}

export class BalanceSheetDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' })
  asOf!: string;
  @ApiProperty({ type: ReportSectionDto }) assets!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) liabilities!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) equity!: ReportSectionDto;
  @ApiMoney() totalAssets!: string;
  @ApiMoney() totalLiabilities!: string;
  @ApiMoney() totalEquity!: string;
  @ApiMoney({
    description:
      'Fiscal-year-to-date P&L (closings excluded) — the "Laba (Rugi) Berjalan" (CURRENT_EARNINGS) equity line; ties to the income statement over [fiscal-year start, asOf].',
  })
  currentYearEarnings!: string;
  @ApiMoney({
    description:
      'P&L of EARLIER fiscal years that were never closed (or were reopened), presented as retained earnings in the "Laba Ditahan (tahun belum ditutup)" (UNCLOSED_PRIOR_EARNINGS) equity line, which is emitted only when non-zero. Zero once every prior year is closed.',
  })
  unclosedPriorYearsEarnings!: string;
  @ApiProperty({ example: true }) balanced!: boolean;
  @ApiPropertyOptional({
    type: () => BalanceSheetComparativeDto,
    description:
      'Only with ?compareAsOf: the same Neraca computed as of compareAsOf (same snapshot as the main report).',
  })
  comparative?: Omit<BalanceSheetDto, 'comparative' | 'variance'>;
  @ApiPropertyOptional({
    type: () => BalanceSheetVarianceDto,
    description: 'Only with ?compareAsOf: current − comparative.',
  })
  variance?: BalanceSheetVarianceDto;
}

export class BalanceSheetComparativeDto extends OmitType(BalanceSheetDto, [
  'comparative',
  'variance',
] as const) {}

export class IncomeStatementDto {
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney() revenue!: string;
  @ApiProperty({ type: [ReportLineDto] }) revenueLines!: ReportLineDto[];
  @ApiMoney() cogs!: string;
  @ApiProperty({ type: [ReportLineDto] }) cogsLines!: ReportLineDto[];
  @ApiMoney() grossProfit!: string;
  @ApiMoney() operatingExpense!: string;
  @ApiProperty({ type: [ReportLineDto] })
  operatingExpenseLines!: ReportLineDto[];
  @ApiMoney() operatingProfit!: string;
  @ApiMoney() otherIncome!: string;
  @ApiProperty({ type: [ReportLineDto] }) otherIncomeLines!: ReportLineDto[];
  @ApiMoney() otherExpense!: string;
  @ApiProperty({ type: [ReportLineDto] }) otherExpenseLines!: ReportLineDto[];
  @ApiMoney() profitBeforeTax!: string;
  @ApiMoney() taxExpense!: string;
  @ApiProperty({
    type: [ReportLineDto],
    description: 'The TAX_EXPENSE-role account(s) (Beban Pajak Penghasilan).',
  })
  taxExpenseLines!: ReportLineDto[];
  @ApiMoney() netIncome!: string;
  @ApiPropertyOptional({
    type: () => IncomeStatementComparativeDto,
    description:
      'Only with ?compareFrom&compareTo: the same Laba Rugi computed over the comparison period (same snapshot as the main report).',
  })
  comparative?: Omit<IncomeStatementDto, 'comparative' | 'variance'>;
  @ApiPropertyOptional({
    type: () => IncomeStatementVarianceDto,
    description: 'Only with ?compareFrom&compareTo: current − comparative.',
  })
  variance?: IncomeStatementVarianceDto;
}

export class IncomeStatementComparativeDto extends OmitType(
  IncomeStatementDto,
  ['comparative', 'variance'] as const,
) {}

export class GeneralLedgerAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] }) normalBalance!: string;
}

export class GeneralLedgerLineDto {
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ nullable: true }) entryRef!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney() runningBalance!: string;
}

export class GeneralLedgerDto {
  @ApiProperty({ type: GeneralLedgerAccountDto })
  account!: GeneralLedgerAccountDto;
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney({
    description:
      "Balance before the first line of this page: the balance as of the day before `from` on the first page, the previous page's last runningBalance on a cursor page.",
  })
  openingBalance!: string;
  @ApiProperty({ type: [GeneralLedgerLineDto] }) lines!: GeneralLedgerLineDto[];
  @ApiProperty({
    description:
      'True when lines were cut off at the server-side cap (10,000 per page); fetch the rest by repeating the request with cursor=nextCursor. closingBalance stays the true as-of balance at `to` either way.',
  })
  truncated!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque continuation token when truncated, else null. Pass it back as `cursor` (same accountId/from/to) for the next page; that page's openingBalance equals this page's last runningBalance.",
  })
  nextCursor!: string | null;
  @ApiMoney() closingBalance!: string;
}

export class AgingDocumentDto {
  @ApiProperty({ nullable: true }) ref!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueDate!: string | null;
  @ApiMoney() total!: string;
  @ApiMoney() paidAsOf!: string;
  @ApiMoney() outstanding!: string;
  @ApiProperty({ enum: ['Current', '1-30', '31-60', '61-90', '>90'] })
  bucket!: string;
}

export class AgingPartnerDto {
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty() partnerName!: string;
  @ApiProperty({ type: [AgingDocumentDto] }) documents!: AgingDocumentDto[];
  @ApiProperty({
    type: 'object',
    description:
      'Outstanding per bucket, keyed by bucket name (money strings).',
    example: {
      Current: '0.0000',
      '1-30': '500.0000',
      '31-60': '0.0000',
      '61-90': '0.0000',
      '>90': '0.0000',
    },
    additionalProperties: { type: 'string' },
  })
  buckets!: Record<string, string>;
}

export class AgingReportDto {
  @ApiProperty({ enum: ['AR', 'AP'] }) kind!: string;
  @ApiProperty({ type: String, format: 'date' }) asOf!: string;
  @ApiProperty({
    description:
      'True when partners were cut off at the server-side cap (10,000 documents). The cut is at partner boundaries — every returned partner is complete; fetch the rest with ?afterPartnerId=<nextAfterPartnerId>. totalsByBucket / totalOutstanding / documentCount always cover ALL open documents (every page carries the same totals).',
  })
  truncated!: boolean;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'When truncated: pass as afterPartnerId (same asOf) to fetch the next partners. Null when this page is complete.',
  })
  nextAfterPartnerId!: string | null;
  @ApiProperty({ type: [AgingPartnerDto] }) partners!: AgingPartnerDto[];
  @ApiProperty({
    type: 'object',
    description:
      'Grand totals per bucket over ALL open documents (money strings).',
    additionalProperties: { type: 'string' },
  })
  totalsByBucket!: Record<string, string>;
  @ApiMoney({ description: 'Total over ALL open documents.' })
  totalOutstanding!: string;
  @ApiProperty({
    example: 2,
    description: 'Number of ALL open documents (including any cut off).',
  })
  documentCount!: number;
}

export class CashFlowLineDto {
  @ApiProperty({ example: '1-2000' }) code!: string;
  @ApiProperty({ example: 'Piutang Usaha' }) name!: string;
  @ApiMoney() amount!: string;
}

export class CashFlowOperatingDto {
  @ApiProperty({ type: [CashFlowLineDto] }) adjustments!: CashFlowLineDto[];
  @ApiMoney() total!: string;
}

export class CashFlowSectionDto {
  @ApiProperty({ type: [CashFlowLineDto] }) lines!: CashFlowLineDto[];
  @ApiMoney() total!: string;
}

export class CashFlowDto {
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney() netIncome!: string;
  @ApiProperty({ type: CashFlowOperatingDto }) operating!: CashFlowOperatingDto;
  @ApiProperty({ type: CashFlowSectionDto }) investing!: CashFlowSectionDto;
  @ApiProperty({ type: CashFlowSectionDto }) financing!: CashFlowSectionDto;
  @ApiMoney() netChange!: string;
  @ApiMoney() kasAwal!: string;
  @ApiMoney() kasAkhir!: string;
  @ApiProperty({ example: true }) reconciles!: boolean;
}
