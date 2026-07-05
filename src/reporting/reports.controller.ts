import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AgingReportDto,
  BalanceSheetDto,
  CashFlowDto,
  GeneralLedgerDto,
  IncomeStatementDto,
} from './dto/report-response.dto';
import {
  AsOfQueryDto,
  RangeQueryDto,
  LedgerQueryDto,
} from './dto/report-query.dto';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import {
  GeneralLedgerService,
  GL_MAX_RANGE_DAYS,
} from './general-ledger.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cash-flow.service';
import { asOfOrToday, dateRange } from '../common/dates/query-dates';

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
  balanceSheet(@Query() q: AsOfQueryDto) {
    return this.balanceSheetSvc.generate(asOfOrToday(q.asOf));
  }

  @ApiOkResponse({ type: IncomeStatementDto })
  @Get('income-statement')
  incomeStatement(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.incomeStatementSvc.generate(from, to);
  }

  @ApiOkResponse({ type: GeneralLedgerDto })
  @Get('general-ledger')
  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = dateRange(q.from, q.to, GL_MAX_RANGE_DAYS);
    return this.generalLedgerSvc.generate(q.accountId, from, to);
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ar-aging')
  arAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AR', asOfOrToday(q.asOf));
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ap-aging')
  apAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AP', asOfOrToday(q.asOf));
  }

  @ApiOkResponse({ type: CashFlowDto })
  @Get('cash-flow')
  cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.cashFlowSvc.generate(from, to);
  }
}
