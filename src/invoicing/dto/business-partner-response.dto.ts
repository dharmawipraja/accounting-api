// src/invoicing/dto/business-partner-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { PaginatedDto } from '../../common/openapi/paginated-dto';

export class BusinessPartnerResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUST-001' }) code!: string;
  @ApiProperty({ example: 'PT Pelanggan' }) name!: string;
  @ApiProperty({
    nullable: true,
    example: '0012345678901000',
    description: '16 digits',
  })
  npwp!: string | null;
  @ApiProperty({ enum: ['TIN', 'NATIONAL_ID', 'PASSPORT', 'OTHER'] })
  buyerDocumentType!: string;
  @ApiProperty({ nullable: true }) buyerDocumentNumber!: string | null;
  @ApiProperty({ example: '000000' }) nitkuSuffix!: string;
  @ApiProperty({ example: 'IDN' }) country!: string;
  @ApiProperty({ nullable: true, example: 'a@b.com' }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: true }) isCustomer!: boolean;
  @ApiProperty({ example: false }) isVendor!: boolean;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export const BusinessPartnerListResponseDto = PaginatedDto(
  BusinessPartnerResponseDto,
  'BusinessPartnerListResponseDto',
  { totalExample: 87 },
);
