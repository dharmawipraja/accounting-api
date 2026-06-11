import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
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
  createDraft(
    @Body() dto: CreateJournalEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.createDraft({
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  post(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id);
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
