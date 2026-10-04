import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CompanyModule } from '../company/company.module';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import { GeneralLedgerService } from './general-ledger.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cash-flow.service';
import { PartnerStatementService } from './partner-statement.service';
import { ReportsController } from './reports.controller';
import { PpnRecapService } from './ppn-recap.service';

@Module({
  imports: [LedgerModule, CompanyModule],
  providers: [
    BalanceSheetService,
    IncomeStatementService,
    GeneralLedgerService,
    AgingService,
    CashFlowService,
    PartnerStatementService,
    PpnRecapService,
  ],
  controllers: [ReportsController],
  exports: [],
})
export class ReportingModule {}
