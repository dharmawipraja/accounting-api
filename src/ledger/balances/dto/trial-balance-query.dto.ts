import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { AsOfQueryDto } from '../../../common/dto/as-of-query.dto';

export class TrialBalanceQueryDto extends AsOfQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Pre-closing view: exclude a year-end CLOSING entry (and its reopen reversal) dated ON asOf, so P&L accounts show their balances before the close (matches the Neraca). Earlier closings still count. Default false = post-closing ledger view.',
  })
  @IsOptional()
  // Strict: only the literals true/false convert; anything else fails @IsBoolean.
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  preClosing?: boolean;
}
