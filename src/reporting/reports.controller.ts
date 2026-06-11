import { Controller, Get, Query } from '@nestjs/common';
import { AsOfQueryDto, RangeQueryDto } from './dto/report-query.dto';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly balanceSheetSvc: BalanceSheetService,
    private readonly incomeStatementSvc: IncomeStatementService,
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
}
