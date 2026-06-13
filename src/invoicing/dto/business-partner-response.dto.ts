// src/invoicing/dto/business-partner-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class BusinessPartnerResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUST-001' }) code!: string;
  @ApiProperty({ example: 'PT Pelanggan' }) name!: string;
  @ApiProperty({ nullable: true }) npwp!: string | null;
  @ApiProperty({ nullable: true, example: 'a@b.com' }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: true }) isCustomer!: boolean;
  @ApiProperty({ example: false }) isVendor!: boolean;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
