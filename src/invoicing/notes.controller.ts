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
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  businessDate,
  optionalBusinessDate,
} from '../common/dates/business-date';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { IdempotentWrite } from '../common/idempotency/idempotent-write.decorator';
import { DocumentListQueryDto } from './dto/document-list-query.dto';
import { VoidDocumentDto } from './dto/void-document.dto';
import { ApplyPaymentDto } from './dto/create-payment.dto';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';
import { NoteListResponseDto, NoteResponseDto } from './dto/note-response.dto';
import { NoteKindKey, NotesService } from './notes.service';

/** The routes of both note kinds (same role rules as invoices / bills; the
 *  apply / reverse routes mirror POST /payments/:id/apply). */
abstract class NotesController {
  protected abstract readonly kind: NoteKindKey;

  constructor(private readonly notes: NotesService) {}

  @ApiOkResponse({ type: NoteListResponseDto })
  @Get()
  list(@Query() q: DocumentListQueryDto) {
    return this.notes.listPage(this.kind, q);
  }

  @ApiOkResponse({ type: NoteResponseDto })
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.notes.present(await this.notes.getById(this.kind, id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: NoteResponseDto })
  @IdempotentWrite()
  @Post()
  async create(
    @Body() dto: CreateNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const note = await this.notes.createDraft(this.kind, {
      originalId: dto.originalId,
      date: businessDate(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
    return this.notes.present(note);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    const note = await this.notes.update(this.kind, id, {
      date: optionalBusinessDate(dto.date),
      description: dto.description,
      lines: dto.lines,
    });
    return this.notes.present(note);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @IdempotentWrite()
  @Post(':id/post')
  @HttpCode(200)
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notes.present(await this.notes.post(this.kind, id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @IdempotentWrite()
  @ApiBody({ type: VoidDocumentDto, required: false })
  @Post(':id/void')
  @HttpCode(200)
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notes.present(
      await this.notes.void(
        this.kind,
        id,
        user.id,
        optionalBusinessDate(dto?.date),
      ),
    );
  }

  /** Apply part of a POSTED note's unapplied excess (partner credit) to
   *  invoices (credit note) / bills (debit note) of the same partner. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @IdempotentWrite()
  @Post(':id/apply')
  @HttpCode(200)
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notes.present(
      await this.notes.apply(
        this.kind,
        id,
        businessDate(dto.date),
        dto.allocations,
        user.id,
      ),
    );
  }

  /** Reverse one application; the amount returns to the document's
   *  outstanding and the note's unapplied balance. */
  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
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
    return this.notes.present(
      await this.notes.reverseApplication(
        this.kind,
        id,
        applicationId,
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
    await this.notes.deleteDraft(this.kind, id, user.id);
  }
}

/** Nota retur penjualan: returns part of a POSTED sales invoice. */
@ApiTags('Sales Credit Notes')
@ApiBearerAuth()
@Controller('sales-credit-notes')
export class SalesCreditNotesController extends NotesController {
  protected readonly kind = 'SALES' as const;
  // Own constructor: Nest reads the injected types from the decorated class.
  constructor(notes: NotesService) {
    super(notes);
  }
}

/** Nota retur pembelian: returns part of a POSTED purchase bill. */
@ApiTags('Purchase Debit Notes')
@ApiBearerAuth()
@Controller('purchase-debit-notes')
export class PurchaseDebitNotesController extends NotesController {
  protected readonly kind = 'PURCHASE' as const;
  constructor(notes: NotesService) {
    super(notes);
  }
}
