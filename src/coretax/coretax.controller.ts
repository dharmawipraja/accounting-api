import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { SalesInvoicesService } from '../invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../invoicing/purchase-bills.service';
import { NotesService } from '../invoicing/notes.service';
import { SalesInvoiceResponseDto } from '../invoicing/dto/sales-invoice-response.dto';
import { PurchaseBillResponseDto } from '../invoicing/dto/purchase-bill-response.dto';
import { NoteResponseDto } from '../invoicing/dto/note-response.dto';
import { CoretaxService } from './coretax.service';
import {
  DocumentReferenceDto,
  FakturKeluaranQueryDto,
  MarkExportedDto,
  MarkExportedResponseDto,
  RecordTaxInvoiceDto,
} from './dto';

/**
 * Coretax (DJP e-Faktur) routes: the Faktur Pajak Keluaran XML export and
 * the metadata recorded after Coretax processed a document. Writes are
 * APPROVER / ADMIN (like posting); no Idempotency-Key — each write sets
 * metadata to the given values, so a retry is harmless.
 */
@ApiTags('Coretax')
@ApiBearerAuth()
@Controller()
export class CoretaxController {
  constructor(
    private readonly coretax: CoretaxService,
    private readonly invoices: SalesInvoicesService,
    private readonly bills: PurchaseBillsService,
    private readonly notes: NotesService,
  ) {}

  @ApiProduces('application/xml')
  @ApiOkResponse({
    description:
      'Coretax TaxInvoiceBulk import file (attachment). 422 { problems[] } when master data is missing.',
    content: { 'application/xml': { schema: { type: 'string' } } },
  })
  @Get('tax/coretax/faktur-keluaran')
  async exportFakturKeluaran(
    @Query() q: FakturKeluaranQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { xml, count } = await this.coretax.exportFakturKeluaran(q);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="faktur-keluaran_${q.from}_${q.to}.xml"`,
    );
    res.setHeader('X-Coretax-Invoice-Count', String(count));
    return xml;
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: MarkExportedResponseDto })
  @Post('tax/coretax/faktur-keluaran/mark-exported')
  @HttpCode(200)
  markExported(@Body() dto: MarkExportedDto) {
    return this.coretax.markExported(dto.invoiceIds);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @Patch('sales-invoices/:id/tax-invoice')
  async recordTaxInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordTaxInvoiceDto,
  ) {
    await this.coretax.recordTaxInvoice(id, dto);
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: SalesInvoiceResponseDto })
  @Patch('sales-invoices/:id/withholding-slip')
  async invoiceWithholdingSlip(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DocumentReferenceDto,
  ) {
    await this.coretax.recordWithholdingSlip('sales_invoices', id, dto);
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: PurchaseBillResponseDto })
  @Patch('purchase-bills/:id/withholding-slip')
  async billWithholdingSlip(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DocumentReferenceDto,
  ) {
    await this.coretax.recordWithholdingSlip('purchase_bills', id, dto);
    return this.bills.present(await this.bills.getById(id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @Patch('sales-credit-notes/:id/retur-reference')
  async creditNoteRetur(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DocumentReferenceDto,
  ) {
    await this.coretax.recordRetur('sales_credit_notes', id, dto);
    return this.notes.present(await this.notes.getById('SALES', id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: NoteResponseDto })
  @Patch('purchase-debit-notes/:id/retur-reference')
  async debitNoteRetur(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DocumentReferenceDto,
  ) {
    await this.coretax.recordRetur('purchase_debit_notes', id, dto);
    return this.notes.present(await this.notes.getById('PURCHASE', id));
  }
}
