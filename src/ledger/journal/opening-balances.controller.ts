import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JournalEntryResponseDto } from '../journal/dto/journal-response.dto';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { OpeningBalancesDto } from './dto/opening-balances.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';

@ApiTags('Journal')
@ApiBearerAuth()
@Controller('ledger/opening-balances')
export class OpeningBalancesController {
  constructor(private readonly journal: JournalService) {}

  @ApiOkResponse({ type: JournalEntryResponseDto })
  @Roles(Role.ADMIN)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
  @Idempotent()
  @Post()
  @HttpCode(200)
  post(
    @Body() dto: OpeningBalancesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.postOpeningBalances(
      new Date(dto.date),
      dto.balances,
      user.id,
    );
  }
}
