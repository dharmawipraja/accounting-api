import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaxInvoiceStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsBusinessDate } from '../common/validators/is-business-date';
import { TRX_CODES } from '../invoicing/dto/document-line.dto';

/** At most this many invoices per export / mark-exported call. */
export const MAX_EXPORT_INVOICES = 1000;

export class FakturKeluaranQueryDto {
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
  @ApiPropertyOptional({
    enum: ['NONE', 'EXPORTED'],
    description:
      'Only invoices with this taxInvoiceStatus; omitted = NONE and EXPORTED (never APPROVED / CANCELLED — re-uploading those would duplicate a faktur).',
  })
  @IsOptional()
  @IsIn(['NONE', 'EXPORTED'])
  status?: 'NONE' | 'EXPORTED';
}

export class MarkExportedDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EXPORT_INVOICES)
  @IsUUID('all', { each: true })
  invoiceIds!: string[];
}

export class MarkExportedResponseDto {
  @ApiProperty({
    example: 12,
    description: 'Invoices now EXPORTED (already-EXPORTED ones included).',
  })
  updated!: number;
}

export class RecordTaxInvoiceDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '04002500000348920',
    description:
      'NSFP (17 digits) Coretax assigned to the faktur; `null` clears it.',
  })
  @IsOptional()
  @Matches(/^\d{17}$/, { message: 'taxInvoiceNumber must be 17 digits' })
  taxInvoiceNumber?: string | null;
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  taxInvoiceDate?: string | null;
  @ApiPropertyOptional({
    enum: TaxInvoiceStatus,
    description:
      'Omitted: APPROVED when a taxInvoiceNumber is sent, else unchanged. Allowed moves (422 otherwise): NONE→EXPORTED|APPROVED, EXPORTED→NONE|APPROVED, APPROVED→CANCELLED; CANCELLED is final. Same-status writes are allowed.',
  })
  @IsOptional()
  @IsEnum(TaxInvoiceStatus)
  status?: TaxInvoiceStatus;
  @ApiPropertyOptional({
    type: String,
    enum: TRX_CODES,
    nullable: true,
    description:
      'Coretax kode transaksi override; `null` = derived. Not changeable once APPROVED.',
  })
  @IsOptional()
  @IsIn(TRX_CODES)
  trxCode?: string | null;
}

/** A bukti potong / retur reference: both set, or both `null` to clear. */
export class DocumentReferenceDto {
  @ApiProperty({ type: String, nullable: true, maxLength: 64 })
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsString()
  @Matches(/^\S(.*\S)?$/, { message: 'number must be trimmed and non-blank' })
  @MaxLength(64)
  number!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsDateString()
  @IsBusinessDate()
  date!: string | null;
}
