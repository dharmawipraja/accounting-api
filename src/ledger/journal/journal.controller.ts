import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { JournalListQueryDto } from './dto/list-journal-entries.dto';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { JournalPostQueryDto } from './dto/journal-post-query.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { ForbiddenDomainError } from '../../common/errors/domain-errors';

@ApiTags('Journal')
@ApiBearerAuth()
@Controller('ledger/journal-entries')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  list(@Query() q: JournalListQueryDto) {
    return this.journal.list({
      status: q.status,
      sourceType: q.sourceType,
      fiscalYear: q.fiscalYear,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<JournalEntry> {
    return this.journal.getById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async createOrPost(
    @Body() dto: CreateJournalEntryDto,
    @Query() q: JournalPostQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const input = {
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    };
    if (q.post === 'true') {
      // Posting authority is APPROVER+ (the route allows ACCOUNTANT only to
      // create drafts). Block an accountant from create-and-post directly.
      if (user.role === Role.ACCOUNTANT) {
        throw new ForbiddenDomainError(
          'Posting requires an Approver or Admin',
          {
            role: user.role,
          },
        );
      }
      return this.journal.createAndPost(input, user.id, idempotencyKey);
    }
    return this.journal.createDraft(input);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id, idempotencyKey);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id, idempotencyKey);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.journal.deleteDraft(id, user.id);
  }
}
