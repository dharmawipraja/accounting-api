import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { CompanyModule } from '../company/company.module';
import { DocumentNumberService } from './document-number.service';
import { BusinessPartnersService } from './business-partners.service';
import { BusinessPartnersController } from './business-partners.controller';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [DocumentNumberService, BusinessPartnersService],
  controllers: [BusinessPartnersController],
  exports: [DocumentNumberService, BusinessPartnersService],
})
export class InvoicingModule {}
