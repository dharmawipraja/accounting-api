import { IsDateString, IsUUID } from 'class-validator';

export { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

export class RangeQueryDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}

export class LedgerQueryDto {
  @IsUUID() accountId!: string;
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}
