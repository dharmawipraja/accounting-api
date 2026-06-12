import { Controller, Get, Query } from '@nestjs/common';
import { BalancesService, TrialBalance } from './balances.service';
import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  trialBalance(@Query() q: AsOfQueryDto): Promise<TrialBalance> {
    const date = q.asOf ? new Date(q.asOf) : new Date();
    return this.balances.trialBalance(date);
  }
}
