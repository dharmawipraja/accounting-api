import { IsBusinessDate } from '../../common/validators/is-business-date';
import { IsDateString, IsUUID } from 'class-validator';

export { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

export class RangeQueryDto {
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
}

export class LedgerQueryDto {
  @IsUUID() accountId!: string;
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
}
