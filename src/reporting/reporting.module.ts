import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CompanyModule } from '../company/company.module';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [LedgerModule, CompanyModule],
  providers: [BalanceSheetService, IncomeStatementService],
  controllers: [ReportsController],
  exports: [],
})
export class ReportingModule {}
