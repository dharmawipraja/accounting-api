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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccountResponseDto } from './dto/account-response.dto';
import { AccountListResponseDto } from './dto/account-list-response.dto';
import { AccountBalanceDto } from '../balances/dto/balance-response.dto';
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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

@ApiTags('Accounts')
@ApiBearerAuth()
@Controller('ledger/accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  @Get()
  @ApiOkResponse({ type: AccountListResponseDto })
  list(@Query() q: PaginationQueryDto) {
    return this.accounts.list(q);
  }

  @Get(':id/balance')
  @ApiOkResponse({ type: AccountBalanceDto })
  balance(@Param('id', ParseUUIDPipe) id: string, @Query() q: AsOfQueryDto) {
    return this.balances.accountBalance(
      id,
      q.asOf ? new Date(q.asOf) : new Date(),
    );
  }

  @Get(':id')
  @ApiOkResponse({ type: AccountResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Account> {
    return this.accounts.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  @ApiCreatedResponse({ type: AccountResponseDto })
  create(@Body() dto: CreateAccountDto): Promise<Account> {
    return this.accounts.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  @ApiOkResponse({ type: AccountResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
  ): Promise<Account> {
    return this.accounts.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOkResponse({ type: AccountResponseDto })
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<Account> {
    return this.accounts.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.accounts.softDelete(id, user.id);
  }
}
