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
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SalesInvoiceResponseDto } from './dto/sales-invoice-response.dto';
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { UpdateSalesInvoiceDto } from './dto/update-sales-invoice.dto';
import { SalesInvoiceListQueryDto } from './dto/list-sales-invoices.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Idempotent } from '../common/idempotency/idempotent.decorator';

@ApiTags('Sales Invoices')
@ApiBearerAuth()
@Controller('sales-invoices')
export class SalesInvoicesController {
  constructor(private readonly invoices: SalesInvoicesService) {}

  @ApiOkResponse({ type: SalesInvoiceResponseDto, isArray: true })
  @Get()
  async list(@Query() q: SalesInvoiceListQueryDto) {
    const rows = await this.invoices.list(q);
    return rows.map((r) => this.invoices.present(r));
  }

  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: SalesInvoiceResponseDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
  @Idempotent()
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
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesInvoiceDto,
  ) {
    const inv = await this.invoices.update(id, {
      date: dto.date ? new Date(dto.date) : undefined,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
    });
    return this.invoices.present(inv);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
  @Idempotent()
  @Post(':id/post')
  @HttpCode(200)
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoices.present(await this.invoices.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
  @Idempotent()
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoices.present(await this.invoices.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiNoContentResponse()
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.invoices.deleteDraft(id, user.id);
  }
}
