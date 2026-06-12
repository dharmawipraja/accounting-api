import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BalancesService, TrialBalance } from './balances.service';
import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

@ApiTags('Reporting')
@ApiBearerAuth()
@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  trialBalance(@Query() q: AsOfQueryDto): Promise<TrialBalance> {
    const date = q.asOf ? new Date(q.asOf) : new Date();
    return this.balances.trialBalance(date);
  }
}
