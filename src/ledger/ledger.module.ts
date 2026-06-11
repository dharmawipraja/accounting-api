import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { AccountsService } from './accounts/accounts.service';
import { AccountsController } from './accounts/accounts.controller';

@Module({
  imports: [CompanyModule],
  providers: [AccountsService],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class LedgerModule {}
