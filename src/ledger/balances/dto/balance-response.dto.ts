import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../../common/openapi/api-money.decorator';

export class AccountBalanceDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney({ description: 'normalBalance-signed net, 4 dp' }) balance!: string;
}

export class TrialBalanceRowDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney() balance!: string;
}

export class TrialBalanceDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' }) asOf!: string;
  @ApiProperty({ type: [TrialBalanceRowDto] }) rows!: TrialBalanceRowDto[];
  @ApiMoney() totalDebit!: string;
  @ApiMoney() totalCredit!: string;
}
