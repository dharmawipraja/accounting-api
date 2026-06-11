import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/journal-entries')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get(':id')
  get(@Param('id') id: string): Promise<JournalEntry> {
    return this.journal.getById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async createOrPost(
    @Body() dto: CreateJournalEntryDto,
    @Query('post') post: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const input = {
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    };
    if (post === 'true') {
      return this.journal.createAndPost(input, user.id, idempotencyKey);
    }
    return this.journal.createDraft(input);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  post(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id, idempotencyKey);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id, idempotencyKey);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.journal.deleteDraft(id, user.id);
  }
}
