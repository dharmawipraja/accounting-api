import { IsBusinessDate } from '../../common/validators/is-business-date';
import {
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
