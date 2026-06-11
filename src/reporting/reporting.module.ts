import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [LedgerModule, CompanyModule],
  providers: [],
  controllers: [],
  exports: [],
})
export class ReportingModule {}
