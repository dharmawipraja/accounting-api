import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentListQueryDto } from './dto/list-payments.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  async list(@Query() q: PaymentListQueryDto) {
    const rows = await this.payments.list(q);
    return rows.map((r) => this.payments.present(r));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.payments.present(await this.payments.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async create(
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const payment = await this.payments.createDraft({
      direction: dto.direction,
      partnerId: dto.partnerId,
      date: new Date(dto.date),
      cashAccountId: dto.cashAccountId,
      description: dto.description,
      allocations: dto.allocations,
      createdBy: user.id,
    });
    return this.payments.present(payment);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  async post(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.present(await this.payments.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/void')
  @HttpCode(200)
  async void(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.present(await this.payments.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.payments.deleteDraft(id, user.id);
  }
}
