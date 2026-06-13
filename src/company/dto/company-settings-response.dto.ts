import { ApiProperty } from '@nestjs/swagger';

export class CompanySettingsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: true }) singleton!: boolean;
  @ApiProperty({ example: 'PT Contoh' }) legalName!: string;
  @ApiProperty({ nullable: true, example: '01.234.567.8-901.000' }) npwp!:
    | string
    | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: 1 }) fiscalYearStartMonth!: number;
  @ApiProperty({ example: 'IDR' }) baseCurrency!: string;
  @ApiProperty({ example: true }) segregationOfDutiesEnabled!: boolean;
  @ApiProperty({ example: true }) isPkp!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
