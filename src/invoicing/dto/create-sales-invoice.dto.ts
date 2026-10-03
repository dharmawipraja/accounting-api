import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  IsIn,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SalesInvoiceLineDto, TRX_CODES } from './document-line.dto';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';

export class CreateSalesInvoiceDto {
  @IsUUID() partnerId!: string;
  @IsDateString() @IsBusinessDate() date!: string;
  @IsOptional() @IsDateString() @IsBusinessDate() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceLineDto)
  lines!: SalesInvoiceLineDto[];
  @ApiPropertyOptional({
    type: String,
    enum: TRX_CODES,
    nullable: true,
    description:
      'Coretax kode transaksi override; omitted/null = derived at export (04 with DPP Nilai Lain, else 01).',
  })
  @IsOptional()
  @IsIn(TRX_CODES)
  trxCode?: string | null;
}
