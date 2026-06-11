import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { CompanyModule } from '../company/company.module';
import { DocumentNumberService } from './document-number.service';
import { BusinessPartnersService } from './business-partners.service';
import { BusinessPartnersController } from './business-partners.controller';
import { DocumentPostingService } from './document-posting.service';
import { SalesInvoicesService } from './sales-invoices.service';
import { SalesInvoicesController } from './sales-invoices.controller';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [
    DocumentNumberService,
    BusinessPartnersService,
    DocumentPostingService,
    SalesInvoicesService,
  ],
  controllers: [BusinessPartnersController, SalesInvoicesController],
  exports: [
    DocumentNumberService,
    BusinessPartnersService,
    SalesInvoicesService,
  ],
})
export class InvoicingModule {}
