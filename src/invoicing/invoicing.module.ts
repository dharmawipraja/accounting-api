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
import { PurchaseBillsService } from './purchase-bills.service';
import { PurchaseBillsController } from './purchase-bills.controller';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [
    DocumentNumberService,
    BusinessPartnersService,
    DocumentPostingService,
    SalesInvoicesService,
    PurchaseBillsService,
  ],
  controllers: [
    BusinessPartnersController,
    SalesInvoicesController,
    PurchaseBillsController,
  ],
  exports: [
    DocumentNumberService,
    BusinessPartnersService,
    SalesInvoicesService,
    PurchaseBillsService,
  ],
})
export class InvoicingModule {}
