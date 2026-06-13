import { ApiProperty } from '@nestjs/swagger';

export class FiscalPeriodResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 2026 }) fiscalYear!: number;
  @ApiProperty({ example: 1 }) sequence!: number;
  @ApiProperty({ example: '2026-01' }) name!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-01' })
  startDate!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' })
  endDate!: string;
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) closedAt!:
    | string
    | null;
  @ApiProperty({ format: 'uuid', nullable: true }) closedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
