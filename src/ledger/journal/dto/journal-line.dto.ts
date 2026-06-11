import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsMoneyString } from '../../../common/validators/is-money-string';

export class JournalLineDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsMoneyString() debit?: string;
  @IsOptional() @IsMoneyString() credit?: string;
  @IsOptional() @IsString() description?: string;
}
