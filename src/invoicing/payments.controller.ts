import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  PaymentListResponseDto,
  PaymentResponseDto,
} from './dto/payment-response.dto';
import { PaymentsService } from './payments.service';
import {
  ApplyPaymentDto,
  CreatePaymentDto,
  RefundCreditDto,
  refundInput,
} from './dto/create-payment.dto';
import { PaymentListQueryDto } from './dto/list-payments.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { IdempotentWrite } from '../common/idempotency/idempotent-write.decorator';
import { VoidDocumentDto } from './dto/void-document.dto';
import {
  businessDate,
  optionalBusinessDate,
} from '../common/dates/business-date';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiOkResponse({ type: PaymentListResponseDto })
  @Get()
  list(@Query() q: PaymentListQueryDto) {
    return this.payments.listPage(q);
  }

  @ApiOkResponse({ type: PaymentResponseDto })
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.present(await this.payments.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @Post()
  async create(
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const payment = await this.payments.createDraft({
      direction: dto.direction,
      partnerId: dto.partnerId,
      date: businessDate(dto.date),
      cashAccountId: dto.cashAccountId,
      opening: dto.opening,
      description: dto.description,
      amount: dto.amount,
      allocations: dto.allocations ?? [],
      createdBy: user.id,
    });
    return this.payments.present(payment);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @Post(':id/post')
  @HttpCode(200)
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(await this.payments.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @ApiBody({ type: VoidDocumentDto, required: false })
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(
      await this.payments.void(id, user.id, optionalBusinessDate(dto?.date)),
    );
  }

  /** Apply part of a POSTED payment's unapplied (advance) amount to
   *  invoices (receipt) / bills (disbursement) of the same partner. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @Post(':id/apply')
  @HttpCode(200)
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(
      await this.payments.apply(
        id,
        businessDate(dto.date),
        dto.allocations,
        user.id,
      ),
    );
  }

  /** Reverse one application (its journal entry); the amount returns to the
   *  document's outstanding and the payment's unapplied balance. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @ApiBody({ type: VoidDocumentDto, required: false })
  @Post(':id/applications/:applicationId/reverse')
  @HttpCode(200)
  async reverseApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(
      await this.payments.reverseApplication(
        id,
        applicationId,
        user.id,
        optionalBusinessDate(dto?.date),
      ),
    );
  }

  /** Refund part of a POSTED payment's unapplied (advance) amount in cash:
   *  Dr Uang Muka Pelanggan / Cr cash (receipt), Dr cash / Cr Uang Muka
   *  Pembelian (disbursement). Same roles and SoD as apply. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @Post(':id/refunds')
  @HttpCode(200)
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundCreditDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(
      await this.payments.refund(id, refundInput(dto), user.id),
    );
  }

  /** Reverse one refund (its journal entry); the amount returns to the
   *  payment's unapplied balance. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PaymentResponseDto })
  @IdempotentWrite()
  @ApiBody({ type: VoidDocumentDto, required: false })
  @Post(':id/refunds/:refundId/reverse')
  @HttpCode(200)
  async reverseRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.present(
      await this.payments.reverseRefund(
        id,
        refundId,
        user.id,
        optionalBusinessDate(dto?.date),
      ),
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
    await this.payments.deleteDraft(id, user.id);
  }
}
