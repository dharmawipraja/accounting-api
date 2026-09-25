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
  businessDate,
  optionalBusinessDate,
} from '../common/dates/business-date';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  SalesInvoiceListResponseDto,
  SalesInvoiceResponseDto,
} from './dto/sales-invoice-response.dto';
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { UpdateSalesInvoiceDto } from './dto/update-sales-invoice.dto';
import { DocumentListQueryDto } from './dto/document-list-query.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { IdempotentWrite } from '../common/idempotency/idempotent-write.decorator';
import { VoidDocumentDto } from './dto/void-document.dto';

@ApiTags('Sales Invoices')
@ApiBearerAuth()
@Controller('sales-invoices')
export class SalesInvoicesController {
  constructor(private readonly invoices: SalesInvoicesService) {}

  @ApiOkResponse({ type: SalesInvoiceListResponseDto })
  @Get()
  list(@Query() q: DocumentListQueryDto) {
    return this.invoices.listPage(q);
  }

  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: SalesInvoiceResponseDto })
  @IdempotentWrite()
  @Post()
  async create(
    @Body() dto: CreateSalesInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const inv = await this.invoices.createDraft({
      partnerId: dto.partnerId,
      date: businessDate(dto.date),
      dueDate: optionalBusinessDate(dto.dueDate),
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
      date: optionalBusinessDate(dto.date),
      dueDate: optionalBusinessDate(dto.dueDate),
      description: dto.description,
      lines: dto.lines,
    });
    return this.invoices.present(inv);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @IdempotentWrite()
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
  @IdempotentWrite()
  @ApiBody({ type: VoidDocumentDto, required: false })
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoices.present(
      await this.invoices.void(id, user.id, optionalBusinessDate(dto?.date)),
    );
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
