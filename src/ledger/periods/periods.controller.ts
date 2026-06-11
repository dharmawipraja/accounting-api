import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AccountingPeriod } from '@prisma/client';
import { PeriodsService } from './periods.service';
import { GeneratePeriodsDto } from './dto/generate-periods.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  list(
    @Query('fiscalYear', ParseIntPipe) fiscalYear: number,
  ): Promise<AccountingPeriod[]> {
    return this.periods.list(fiscalYear);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post('generate')
  generate(@Body() dto: GeneratePeriodsDto): Promise<AccountingPeriod[]> {
    return this.periods.generatePeriods(dto.fiscalYear);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/close')
  @HttpCode(200)
  close(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountingPeriod> {
    return this.periods.close(id, user.id);
  }

  @Roles(Role.ADMIN)
  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Param('id') id: string): Promise<AccountingPeriod> {
    return this.periods.reopen(id);
  }
}
