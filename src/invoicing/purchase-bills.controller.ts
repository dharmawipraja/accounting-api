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
import {
  PurchaseBillListResponseDto,
  PurchaseBillResponseDto,
} from './dto/purchase-bill-response.dto';
import { PurchaseBillsService } from './purchase-bills.service';
import { CreatePurchaseBillDto } from './dto/create-purchase-bill.dto';
import { UpdatePurchaseBillDto } from './dto/update-purchase-bill.dto';
import { PurchaseBillListQueryDto } from './dto/list-purchase-bills.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Idempotent } from '../common/idempotency/idempotent.decorator';

@ApiTags('Purchase Bills')
@ApiBearerAuth()
@Controller('purchase-bills')
export class PurchaseBillsController {
  constructor(private readonly bills: PurchaseBillsService) {}

  @ApiOkResponse({ type: PurchaseBillListResponseDto })
  @Get()
  list(@Query() q: PurchaseBillListQueryDto) {
    return this.bills.listPage(q);
  }

  @ApiOkResponse({ type: PurchaseBillResponseDto })
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.bills.present(await this.bills.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: PurchaseBillResponseDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
  @Idempotent()
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
  @ApiOkResponse({ type: PurchaseBillResponseDto })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseBillDto,
  ) {
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
  @ApiOkResponse({ type: PurchaseBillResponseDto })
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
    return this.bills.present(await this.bills.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PurchaseBillResponseDto })
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
    return this.bills.present(await this.bills.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiNoContentResponse()
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.bills.deleteDraft(id, user.id);
  }
}
