import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  AccountSubtype,
  AccountType,
  CashFlowCategory,
  NormalBalance,
} from '@prisma/client';

export class CreateAccountDto {
  @IsString() @MaxLength(32) code!: string;
  @IsString() @MaxLength(128) name!: string;
  @IsEnum(AccountType) type!: AccountType;
  @IsEnum(AccountSubtype) subtype!: AccountSubtype;
  @IsEnum(NormalBalance) normalBalance!: NormalBalance;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsString() parentCode?: string;
}
