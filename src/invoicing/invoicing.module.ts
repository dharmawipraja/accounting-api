import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { CompanyModule } from '../company/company.module';
import { DocumentNumberService } from './document-number.service';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [DocumentNumberService],
  controllers: [],
  exports: [DocumentNumberService],
})
export class InvoicingModule {}
