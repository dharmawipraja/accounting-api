import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { CoretaxController } from './coretax.controller';
import { CoretaxService } from './coretax.service';

@Module({
  imports: [CompanyModule, InvoicingModule],
  providers: [CoretaxService],
  controllers: [CoretaxController],
})
export class CoretaxModule {}
