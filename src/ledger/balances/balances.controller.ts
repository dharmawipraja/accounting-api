import { Controller, Get, Query } from '@nestjs/common';
import { BalancesService, TrialBalance } from './balances.service';

@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  trialBalance(@Query('asOf') asOf?: string): Promise<TrialBalance> {
    const date = asOf ? new Date(asOf) : new Date();
    return this.balances.trialBalance(date);
  }
}
