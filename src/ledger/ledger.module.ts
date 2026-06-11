import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { AccountsService } from './accounts/accounts.service';
import { AccountsController } from './accounts/accounts.controller';
import { PeriodsService } from './periods/periods.service';
import { PeriodsController } from './periods/periods.controller';
import { PostingService } from './posting/posting.service';
import { JournalService } from './journal/journal.service';
import { JournalController } from './journal/journal.controller';

@Module({
  imports: [CompanyModule],
  providers: [AccountsService, PeriodsService, PostingService, JournalService],
  controllers: [AccountsController, PeriodsController, JournalController],
  exports: [AccountsService, PeriodsService, PostingService, JournalService],
})
export class LedgerModule {}
