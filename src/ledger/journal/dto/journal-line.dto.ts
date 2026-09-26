import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsMoneyString } from '../../../common/validators/is-money-string';

export class JournalLineDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsMoneyString() debit?: string;
  @IsOptional() @IsMoneyString() credit?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
