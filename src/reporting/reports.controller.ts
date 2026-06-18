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
import { GeneralLedgerService } from './general-ledger.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cash-flow.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

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

  private range(q: { from: string; to: string }): { from: Date; to: Date } {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from.getTime() > to.getTime()) {
      throw new ValidationFailedError('`from` must be on or before `to`', {
        from: q.from,
        to: q.to,
      });
    }
    return { from, to };
  }

  @ApiOkResponse({ type: BalanceSheetDto })
  @Get('balance-sheet')
  balanceSheet(@Query() q: AsOfQueryDto) {
    return this.balanceSheetSvc.generate(
      q.asOf ? new Date(q.asOf) : new Date(),
    );
  }

  @ApiOkResponse({ type: IncomeStatementDto })
  @Get('income-statement')
  incomeStatement(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.incomeStatementSvc.generate(from, to);
  }

  @ApiOkResponse({ type: GeneralLedgerDto })
  @Get('general-ledger')
  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = this.range(q);
    return this.generalLedgerSvc.generate(q.accountId, from, to);
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ar-aging')
  arAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AR', q.asOf ? new Date(q.asOf) : new Date());
  }

  @ApiOkResponse({ type: AgingReportDto })
  @Get('ap-aging')
  apAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AP', q.asOf ? new Date(q.asOf) : new Date());
  }

  @ApiOkResponse({ type: CashFlowDto })
  @Get('cash-flow')
  cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.cashFlowSvc.generate(from, to);
  }
}
