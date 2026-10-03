import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BalancesService } from './balances.service';
import { ApiReportResponse, exportOr } from '../../reporting/export/render';
import { trialBalanceTable } from '../../reporting/export/tables';
import { TrialBalanceQueryDto } from './dto/trial-balance-query.dto';
import { TrialBalanceDto } from './dto/balance-response.dto';
import { asOfOrToday } from '../../common/dates/query-dates';

@ApiTags('Reporting')
@ApiBearerAuth()
@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  @ApiReportResponse(TrialBalanceDto)
  async trialBalance(@Query() q: TrialBalanceQueryDto) {
    const r = await this.balances.trialBalance(asOfOrToday(q.asOf), {
      preClosing: q.preClosing,
    });
    return exportOr(
      q.format,
      r,
      (t) => trialBalanceTable(t, q.preClosing),
      `trial-balance-${r.asOf}`,
    );
  }
}
