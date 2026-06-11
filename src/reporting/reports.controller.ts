import { Controller, Get, Query } from '@nestjs/common';
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

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly balanceSheetSvc: BalanceSheetService,
    private readonly incomeStatementSvc: IncomeStatementService,
    private readonly generalLedgerSvc: GeneralLedgerService,
    private readonly aging: AgingService,
    private readonly cashFlow: CashFlowService,
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

  @Get('balance-sheet')
  balanceSheet(@Query() q: AsOfQueryDto) {
    return this.balanceSheetSvc.generate(
      q.asOf ? new Date(q.asOf) : new Date(),
    );
  }

  @Get('income-statement')
  incomeStatement(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.incomeStatementSvc.generate(from, to);
  }

  @Get('general-ledger')
  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = this.range(q);
    return this.generalLedgerSvc.generate(q.accountId, from, to);
  }

  @Get('ar-aging')
  arAging(@Query() q: AsOfQueryDto) {
    return this.aging.aging('AR', q.asOf ? new Date(q.asOf) : new Date());
  }

  @Get('ap-aging')
  apAging(@Query() q: AsOfQueryDto) {
    return this.aging.aging('AP', q.asOf ? new Date(q.asOf) : new Date());
  }

  @Get('cash-flow')
  cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.cashFlow.generate(from, to);
  }
}
