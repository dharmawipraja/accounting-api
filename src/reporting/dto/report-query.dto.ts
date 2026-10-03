import { IsBusinessDate } from '../../common/validators/is-business-date';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

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
