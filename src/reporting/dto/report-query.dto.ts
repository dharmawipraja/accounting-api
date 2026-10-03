import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Transform } from 'class-transformer';
import { GL_MAX_ACCOUNTS } from '../general-ledger.service';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';
export { AsOfQueryDto };

export class AgingQueryDto extends AsOfQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "Continue a truncated aging: list only partners after this one (a previous page's nextAfterPartnerId, same asOf). Totals still cover the whole report.",
  })
  @IsOptional()
  @IsUUID()
  afterPartnerId?: string;
}

export class RangeQueryDto {
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
}

export class IncomeStatementQueryDto extends RangeQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description:
      'Comparison period start (requires compareTo; same rules as from/to). Adds `comparative` + `variance` to the response.',
  })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  compareFrom?: string;
  @ApiPropertyOptional({
    format: 'date',
    description: 'Comparison period end (requires compareFrom).',
  })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  compareTo?: string;
}

export class BalanceSheetQueryDto extends AsOfQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description:
      'Comparison date. Adds `comparative` (the Neraca as of this date) + `variance` to the response.',
  })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  compareAsOf?: string;
}

export class LedgerQueryDto {
  @IsUUID() accountId!: string;
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
  @ApiPropertyOptional({
    description:
      "Continuation token from a truncated response's nextCursor (same accountId/from/to). Omit for the first page.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class LedgerBookQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: `Comma-separated account ids (at most ${GL_MAX_ACCOUNTS}). Mutually exclusive with fromCode/toCode.`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').map((s) => s.trim()) : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(GL_MAX_ACCOUNTS)
  @IsUUID('all', { each: true })
  accountIds?: string[];
  @ApiPropertyOptional({
    description: `Lowest account code (inclusive) of a range of postable accounts. With neither accountIds nor a code bound, every postable account is selected. A range may select at most ${GL_MAX_ACCOUNTS} accounts.`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  fromCode?: string;
  @ApiPropertyOptional({
    description: 'Highest account code (inclusive) of the range.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toCode?: string;
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
  @ApiPropertyOptional({
    description:
      "Continuation token from a truncated response's nextCursor (same selection/from/to). Omit for the first page.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
