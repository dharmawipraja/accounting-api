import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { BalancesService, TrialBalance } from './balances.service';
import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';
import { TrialBalanceDto } from './dto/balance-response.dto';

@ApiTags('Reporting')
@ApiBearerAuth()
@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  @ApiOkResponse({ type: TrialBalanceDto })
  trialBalance(@Query() q: AsOfQueryDto): Promise<TrialBalance> {
    const date = q.asOf ? new Date(q.asOf) : new Date();
    return this.balances.trialBalance(date);
  }
}
