// src/close/dto/closing-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class YearEndClosingResponseDto {
  @ApiProperty({ example: 2026 }) fiscalYear!: number;
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) closingEntryId!:
    | string
    | null;
  @ApiMoney() netIncome!: string;
  @ApiProperty({ format: 'date-time' }) closedAt!: string;
  @ApiProperty({ format: 'uuid' }) closedBy!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) reopenedAt!:
    | string
    | null;
  @ApiProperty({ format: 'uuid', nullable: true }) reopenedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
