import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { YearEndClosing } from '@prisma/client';
import { YearEndCloseService } from './year-end-close.service';
import { CloseYearDto } from './dto/close.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { NotFoundDomainError } from '../common/errors/domain-errors';

@ApiTags('Close')
@ApiBearerAuth()
@Controller('close/year-end')
export class ClosingController {
  constructor(private readonly close: YearEndCloseService) {}

  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(200)
  run(
    @Body() dto: CloseYearDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<YearEndClosing> {
    return this.close.close(dto.fiscalYear, user.id);
  }

  @Roles(Role.ADMIN)
  @Post(':fiscalYear/reopen')
  @HttpCode(200)
  reopen(
    @Param('fiscalYear', ParseIntPipe) fiscalYear: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<YearEndClosing> {
    return this.close.reopen(fiscalYear, user.id);
  }

  @Get(':fiscalYear')
  async status(
    @Param('fiscalYear', ParseIntPipe) fiscalYear: number,
  ): Promise<YearEndClosing> {
    const rec = await this.close.getStatus(fiscalYear);
    if (!rec)
      throw new NotFoundDomainError('No close record for fiscal year', {
        fiscalYear,
      });
    return rec;
  }
}
