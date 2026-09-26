import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  AccountRole,
  AccountSubtype,
  AccountType,
  CashFlowCategory,
  NormalBalance,
} from '@prisma/client';
import { NON_BLANK_MESSAGE } from '../../../common/text/identifier';
import {
  DisplayName,
  IdentifierCode,
} from '../../../common/validators/identifier-code';

/** code / parentCode: NFKC + trimmed, no format/control characters (see
 *  common/text/identifier); name: trimmed, no format characters. code and
 *  name must be non-blank. */
export class CreateAccountDto {
  @IdentifierCode()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(32)
  code!: string;
  @DisplayName()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(128)
  name!: string;
  @IsEnum(AccountType) type!: AccountType;
  @IsEnum(AccountSubtype) subtype!: AccountSubtype;
  @IsEnum(NormalBalance) normalBalance!: NormalBalance;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsEnum(AccountRole) role?: AccountRole;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  // Normalized like a code; a blank parentCode still means "no parent"
  // (the service ignores an empty string), as before.
  @IsOptional()
  @IdentifierCode()
  @IsString()
  @MaxLength(32)
  parentCode?: string;
}
