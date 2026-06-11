import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PurchaseBillsService } from './purchase-bills.service';
import { CreatePurchaseBillDto } from './dto/create-purchase-bill.dto';
import { UpdatePurchaseBillDto } from './dto/update-purchase-bill.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('purchase-bills')
export class PurchaseBillsController {
  constructor(private readonly bills: PurchaseBillsService) {}

  @Get()
  async list(
    @Query('partnerId') partnerId?: string,
    @Query('status') status?: string,
  ) {
    const rows = await this.bills.list({ partnerId, status });
    return rows.map((r) => this.bills.present(r));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.bills.present(await this.bills.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async create(
    @Body() dto: CreatePurchaseBillDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const bill = await this.bills.createDraft({
      partnerId: dto.partnerId,
      vendorInvoiceNo: dto.vendorInvoiceNo,
      date: new Date(dto.date),
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
    return this.bills.present(bill);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdatePurchaseBillDto) {
    const bill = await this.bills.update(id, {
      vendorInvoiceNo: dto.vendorInvoiceNo,
      date: dto.date ? new Date(dto.date) : undefined,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
    });
    return this.bills.present(bill);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  async post(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bills.present(await this.bills.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/void')
  @HttpCode(200)
  async void(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bills.present(await this.bills.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.bills.deleteDraft(id, user.id);
  }
}
