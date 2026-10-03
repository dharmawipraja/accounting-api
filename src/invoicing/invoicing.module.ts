import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { CompanyModule } from '../company/company.module';
import { TaxedDocumentService } from './taxed-document.service';
import { BusinessPartnersService } from './business-partners.service';
import { BusinessPartnersController } from './business-partners.controller';
import { DocumentPostingService } from './document-posting.service';
import { SalesInvoicesService } from './sales-invoices.service';
import { SalesInvoicesController } from './sales-invoices.controller';
import { PurchaseBillsService } from './purchase-bills.service';
import { PurchaseBillsController } from './purchase-bills.controller';
import { PaymentsService } from './payments.service';
import { CreditApplicationService } from './credit-application';
import { PaymentsController } from './payments.controller';
import { JournalPreviewService } from './journal-preview.service';
import { JournalPreviewController } from './journal-preview.controller';
import { NotesService } from './notes.service';
import {
  PurchaseDebitNotesController,
  SalesCreditNotesController,
} from './notes.controller';

@Module({
  imports: [LedgerModule, TaxModule, CompanyModule],
  providers: [
    TaxedDocumentService,
    BusinessPartnersService,
    DocumentPostingService,
    SalesInvoicesService,
    PurchaseBillsService,
    PaymentsService,
    CreditApplicationService,
    JournalPreviewService,
    NotesService,
  ],
  controllers: [
    BusinessPartnersController,
    SalesInvoicesController,
    PurchaseBillsController,
    PaymentsController,
    JournalPreviewController,
    SalesCreditNotesController,
    PurchaseDebitNotesController,
  ],
  exports: [
    BusinessPartnersService,
    SalesInvoicesService,
    PurchaseBillsService,
    PaymentsService,
    NotesService,
  ],
})
export class InvoicingModule {}
