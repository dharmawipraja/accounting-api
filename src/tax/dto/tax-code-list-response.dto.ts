import { ApiProperty } from '@nestjs/swagger';
import { TaxCodeResponseDto } from './tax-code-response.dto';

export class TaxCodeListResponseDto {
  @ApiProperty({ type: [TaxCodeResponseDto] }) data!: TaxCodeResponseDto[];
  @ApiProperty({ example: 6 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
