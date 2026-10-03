import { ApiProperty } from '@nestjs/swagger';

export class CompanySettingsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: true }) singleton!: boolean;
  @ApiProperty({ example: 'PT Contoh' }) legalName!: string;
  @ApiProperty({
    nullable: true,
    example: '0012345678901000',
    description: '16 digits',
  })
  npwp!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: 1 }) fiscalYearStartMonth!: number;
  @ApiProperty({ example: 'IDR' }) baseCurrency!: string;
  @ApiProperty({ example: true }) segregationOfDutiesEnabled!: boolean;
  @ApiProperty({ example: true }) isPkp!: boolean;
  @ApiProperty({ example: '000000' }) nitkuSuffix!: string;
  @ApiProperty({ enum: ['A', 'B'], nullable: true })
  coretaxDefaultItemType!: string | null;
  @ApiProperty({ example: '000000' }) coretaxDefaultItemCode!: string;
  @ApiProperty({ nullable: true, example: 'UM.0018' })
  coretaxDefaultUnitCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
