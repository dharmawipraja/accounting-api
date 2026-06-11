import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxCodesService } from './tax-codes.service';
import { TaxCodesController } from './tax-codes.controller';
import { TaxService } from './tax.service';
import { TaxController } from './tax.controller';

@Module({
  imports: [LedgerModule],
  providers: [TaxCodesService, TaxService],
  controllers: [TaxCodesController, TaxController],
  exports: [TaxCodesService, TaxService],
})
export class TaxModule {}
