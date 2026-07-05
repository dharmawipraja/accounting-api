// src/reporting/dto/report-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
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

export class BalanceSheetDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' })
  asOf!: string;
  @ApiProperty({ type: ReportSectionDto }) assets!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) liabilities!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) equity!: ReportSectionDto;
  @ApiMoney() totalAssets!: string;
  @ApiMoney() totalLiabilities!: string;
  @ApiMoney() totalEquity!: string;
  @ApiMoney() currentYearEarnings!: string;
  @ApiProperty({ example: true }) balanced!: boolean;
}

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
  @ApiMoney() otherExpense!: string;
  @ApiMoney() profitBeforeTax!: string;
  @ApiMoney() taxExpense!: string;
  @ApiMoney() netIncome!: string;
}

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
  @ApiMoney() openingBalance!: string;
  @ApiProperty({ type: [GeneralLedgerLineDto] }) lines!: GeneralLedgerLineDto[];
  @ApiProperty({
    description:
      'True when lines were cut off at the server-side cap (10,000); narrow the date range to see the rest. closingBalance stays the true as-of balance either way.',
  })
  truncated!: boolean;
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
      'True when open documents were cut off at the server-side cap (10,000); totals cover only the included documents.',
  })
  truncated!: boolean;
  @ApiProperty({ type: [AgingPartnerDto] }) partners!: AgingPartnerDto[];
  @ApiProperty({
    type: 'object',
    description: 'Grand totals per bucket (money strings).',
    additionalProperties: { type: 'string' },
  })
  totalsByBucket!: Record<string, string>;
  @ApiMoney() totalOutstanding!: string;
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
