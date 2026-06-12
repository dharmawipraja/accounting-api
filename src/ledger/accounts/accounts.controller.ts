import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Account } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { BalancesService } from '../balances/balances.service';
import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

@Controller('ledger/accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  @Get()
  list(): Promise<Account[]> {
    return this.accounts.list();
  }

  @Get(':id/balance')
  balance(@Param('id', ParseUUIDPipe) id: string, @Query() q: AsOfQueryDto) {
    return this.balances.accountBalance(
      id,
      q.asOf ? new Date(q.asOf) : new Date(),
    );
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Account> {
    return this.accounts.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  create(@Body() dto: CreateAccountDto): Promise<Account> {
    return this.accounts.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
  ): Promise<Account> {
    return this.accounts.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<Account> {
    return this.accounts.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.accounts.softDelete(id, user.id);
  }
}
