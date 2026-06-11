import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CompanyModule } from '../company/company.module';
import { YearEndCloseService } from './year-end-close.service';
import { ClosingController } from './closing.controller';

@Module({
  imports: [LedgerModule, CompanyModule],
  providers: [YearEndCloseService],
  controllers: [ClosingController],
  exports: [YearEndCloseService],
})
export class CloseModule {}
