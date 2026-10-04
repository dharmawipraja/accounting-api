import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiReportResponse, exportOr } from './export/render';
import {
  agingTable,
  balanceSheetTable,
  cashFlowTable,
  generalLedgerBookTable,
  generalLedgerTable,
  incomeStatementTable,
} from './export/tables';
import {
  AgingReportDto,
  BalanceSheetDto,
  CashFlowDto,
  GeneralLedgerBookResponseDto,
  GeneralLedgerDto,
  IncomeStatementDto,
} from './dto/report-response.dto';
import {
  AgingQueryDto,
  RangeQueryDto,
  LedgerQueryDto,
  LedgerBookQueryDto,
} from './dto/report-query.dto';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import {
  GeneralLedgerService,
  GL_MAX_LINES,
  GL_MAX_RANGE_DAYS,
} from './general-ledger.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cash-flow.service';
import { asOfOrToday, dateRange } from '../common/dates/query-dates';
import { businessDate } from '../common/dates/business-date';
import { ValidationFailedError } from '../common/errors/domain-errors';
import {
  BalanceSheetQueryDto,
  IncomeStatementQueryDto,
} from './dto/report-query.dto';
import {
  PartnerStatementQueryDto,
  PartnerStatementResponseDto,
} from './dto/partner-statement.dto';
import { PartnerStatementService } from './partner-statement.service';
import { safeFilePart } from './partner-statement';
import { partnerStatementTable } from './export/partner-statement-table';

@ApiTags('Reporting')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly balanceSheetSvc: BalanceSheetService,
    private readonly incomeStatementSvc: IncomeStatementService,
    private readonly generalLedgerSvc: GeneralLedgerService,
    private readonly agingSvc: AgingService,
    private readonly cashFlowSvc: CashFlowService,
    private readonly partnerStatementSvc: PartnerStatementService,
  ) {}

  @ApiReportResponse(BalanceSheetDto)
  @Get('balance-sheet')
  async balanceSheet(@Query() q: BalanceSheetQueryDto) {
    const r = await this.balanceSheetSvc.generate(
      asOfOrToday(q.asOf),
      q.compareAsOf === undefined ? undefined : businessDate(q.compareAsOf),
    );
    return exportOr(q.format, r, balanceSheetTable, `balance-sheet-${r.asOf}`);
  }

  @ApiReportResponse(IncomeStatementDto)
  @Get('income-statement')
  async incomeStatement(@Query() q: IncomeStatementQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    if ((q.compareFrom === undefined) !== (q.compareTo === undefined))
      throw new ValidationFailedError(
        '`compareFrom` and `compareTo` must be given together',
        { compareFrom: q.compareFrom, compareTo: q.compareTo },
      );
    const compare =
      q.compareFrom === undefined
        ? undefined
        : dateRange(q.compareFrom, q.compareTo!);
    const r = await this.incomeStatementSvc.generate(from, to, compare);
    return exportOr(
      q.format,
      r,
      incomeStatementTable,
      `income-statement-${r.from}_${r.to}`,
    );
  }

  @ApiReportResponse(GeneralLedgerDto)
  @Get('general-ledger')
  async generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    const r = await this.generalLedgerSvc.generate(
      q.accountId,
      from,
      to,
      GL_MAX_LINES,
      q.cursor,
    );
    return exportOr(
      q.format,
      r,
      generalLedgerTable,
      `general-ledger-${r.from}_${r.to}`,
    );
  }

  @ApiReportResponse(GeneralLedgerBookResponseDto)
  @Get('general-ledger/book')
  async generalLedgerBook(@Query() q: LedgerBookQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    if (q.accountIds && (q.fromCode !== undefined || q.toCode !== undefined))
      throw new ValidationFailedError(
        'Pass either accountIds or fromCode/toCode, not both',
        {},
      );
    const r = await this.generalLedgerSvc.generateBook(
      q.accountIds
        ? { accountIds: q.accountIds }
        : { fromCode: q.fromCode, toCode: q.toCode },
      from,
      to,
      GL_MAX_LINES,
      q.cursor,
    );
    return exportOr(
      q.format,
      r,
      generalLedgerBookTable,
      `general-ledger-book-${r.from}_${r.to}`,
    );
  }

  @ApiReportResponse(AgingReportDto)
  @Get('ar-aging')
  async arAging(@Query() q: AgingQueryDto) {
    const r = await this.agingSvc.aging(
      'AR',
      asOfOrToday(q.asOf),
      q.afterPartnerId,
      undefined,
      undefined,
      q.partnerId,
    );
    return exportOr(q.format, r, agingTable, `ar-aging-${r.asOf}`);
  }

  @ApiReportResponse(AgingReportDto)
  @Get('ap-aging')
  async apAging(@Query() q: AgingQueryDto) {
    const r = await this.agingSvc.aging(
      'AP',
      asOfOrToday(q.asOf),
      q.afterPartnerId,
      undefined,
      undefined,
      q.partnerId,
    );
    return exportOr(q.format, r, agingTable, `ap-aging-${r.asOf}`);
  }

  @ApiReportResponse(CashFlowDto)
  @Get('cash-flow')
  async cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    const r = await this.cashFlowSvc.generate(from, to);
    return exportOr(q.format, r, cashFlowTable, `cash-flow-${r.from}_${r.to}`);
  }

  @ApiReportResponse(PartnerStatementResponseDto)
  @Get('partner-statement')
  async partnerStatement(@Query() q: PartnerStatementQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    const r = await this.partnerStatementSvc.generate(
      q.partnerId,
      q.side,
      from,
      to,
    );
    return exportOr(
      q.format,
      r,
      partnerStatementTable,
      `partner-statement-${safeFilePart(r.partner.code)}-${r.from}_${r.to}`,
    );
  }
}
