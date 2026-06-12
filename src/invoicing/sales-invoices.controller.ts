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
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { UpdateSalesInvoiceDto } from './dto/update-sales-invoice.dto';
import { SalesInvoiceListQueryDto } from './dto/list-sales-invoices.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('sales-invoices')
export class SalesInvoicesController {
  constructor(private readonly invoices: SalesInvoicesService) {}

  @Get()
  async list(@Query() q: SalesInvoiceListQueryDto) {
    const rows = await this.invoices.list(q);
    return rows.map((r) => this.invoices.present(r));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async create(
    @Body() dto: CreateSalesInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const inv = await this.invoices.createDraft({
      partnerId: dto.partnerId,
      date: new Date(dto.date),
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
    return this.invoices.present(inv);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSalesInvoiceDto) {
    const inv = await this.invoices.update(id, {
      date: dto.date ? new Date(dto.date) : undefined,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
    });
    return this.invoices.present(inv);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  async post(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.present(await this.invoices.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/void')
  @HttpCode(200)
  async void(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.present(await this.invoices.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.invoices.deleteDraft(id, user.id);
  }
}
