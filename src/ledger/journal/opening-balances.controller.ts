import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { OpeningBalancesDto } from './dto/opening-balances.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/opening-balances')
export class OpeningBalancesController {
  constructor(private readonly journal: JournalService) {}

  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(200)
  post(
    @Body() dto: OpeningBalancesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.postOpeningBalances(
      new Date(dto.date),
      dto.balances,
      user.id,
      idempotencyKey,
    );
  }
}
