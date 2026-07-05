import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class JournalPreviewLineDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ example: '1-1210' }) accountCode!: string;
  @ApiProperty({ example: 'Piutang Usaha' }) accountName!: string;
  @ApiMoney({
    description: 'Debit, 4dp string ("0.0000" if this is a credit line)',
  })
  debit!: string;
  @ApiMoney({
    description: 'Credit, 4dp string ("0.0000" if this is a debit line)',
  })
  credit!: string;
}

export class JournalPreviewResponseDto {
  @ApiProperty({ type: [JournalPreviewLineDto] })
  lines!: JournalPreviewLineDto[];
  @ApiMoney() totalDebit!: string;
  @ApiMoney() totalCredit!: string;
  @ApiProperty({ example: true }) balanced!: boolean;
}
