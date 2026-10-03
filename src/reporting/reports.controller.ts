import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
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
  ) {}

  @ApiOkResponse({ type: BalanceSheetDto })
  @Get('balance-sheet')
  balanceSheet(@Query() q: BalanceSheetQueryDto) {
    return this.balanceSheetSvc.generate(
      asOfOrToday(q.asOf),
      q.compareAsOf === undefined ? undefined : businessDate(q.compareAsOf),
    );
  }

  @ApiOkResponse({ type: IncomeStatementDto })
  @Get('income-statement')
  incomeStatement(@Query() q: IncomeStatementQueryDto) {
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
    return this.incomeStatementSvc.generate(from, to, compare);
  }

  @ApiOkResponse({ type: GeneralLedgerDto })
  @Get('general-ledger')
  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    return this.generalLedgerSvc.generate(
      q.accountId,
      from,
      to,
      GL_MAX_LINES,
      q.cursor,
    );
  }

  @ApiOkResponse({ type: GeneralLedgerBookResponseDto })
  @Get('general-ledger/book')
  generalLedgerBook(@Query() q: LedgerBookQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    if (q.accountIds && (q.fromCode !== undefined || q.toCode !== undefined))
      throw new ValidationFailedError(
        'Pass either accountIds or fromCode/toCode, not both',
        {},
      );
    return this.generalLedgerSvc.generateBook(
      q.accountIds
        ? { accountIds: q.accountIds }
        : { fromCode: q.fromCode, toCode: q.toCode },
      from,
      to,
      GL_MAX_LINES,
      q.cursor,
    );
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ar-aging')
  arAging(@Query() q: AgingQueryDto) {
    return this.agingSvc.aging('AR', asOfOrToday(q.asOf), q.afterPartnerId);
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ap-aging')
  apAging(@Query() q: AgingQueryDto) {
    return this.agingSvc.aging('AP', asOfOrToday(q.asOf), q.afterPartnerId);
  }

  @ApiOkResponse({ type: CashFlowDto })
  @Get('cash-flow')
  cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.cashFlowSvc.generate(from, to);
  }
}
