import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { AccountsService } from './accounts/accounts.service';
import { AccountsController } from './accounts/accounts.controller';
import { PeriodsService } from './periods/periods.service';
import { PeriodsController } from './periods/periods.controller';

@Module({
  imports: [CompanyModule],
  providers: [AccountsService, PeriodsService],
  controllers: [AccountsController, PeriodsController],
  exports: [AccountsService, PeriodsService],
})
export class LedgerModule {}
