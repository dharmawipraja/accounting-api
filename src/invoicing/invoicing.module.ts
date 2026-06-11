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
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [
    DocumentNumberService,
    BusinessPartnersService,
    DocumentPostingService,
    SalesInvoicesService,
    PurchaseBillsService,
    PaymentsService,
  ],
  controllers: [
    BusinessPartnersController,
    SalesInvoicesController,
    PurchaseBillsController,
    PaymentsController,
  ],
  exports: [
    DocumentNumberService,
    BusinessPartnersService,
    SalesInvoicesService,
    PurchaseBillsService,
    PaymentsService,
  ],
})
export class InvoicingModule {}
