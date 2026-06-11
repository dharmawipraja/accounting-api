import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class AsOfQueryDto {
  @IsOptional() @IsDateString() asOf?: string;
}

export class RangeQueryDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}

export class LedgerQueryDto {
  @IsUUID() accountId!: string;
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}
