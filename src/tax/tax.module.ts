import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxCodesService } from './tax-codes.service';
import { TaxCodesController } from './tax-codes.controller';

@Module({
  imports: [LedgerModule],
  providers: [TaxCodesService],
  controllers: [TaxCodesController],
  exports: [TaxCodesService],
})
export class TaxModule {}
