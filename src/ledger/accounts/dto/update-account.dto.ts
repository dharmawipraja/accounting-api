import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CashFlowCategory } from '@prisma/client';
import { OptionalNonNull } from '../../../common/validators/optional-non-null';
import { NON_BLANK_MESSAGE } from '../../../common/text/identifier';
import { DisplayName } from '../../../common/validators/identifier-code';

export class UpdateAccountDto {
  @OptionalNonNull()
  @DisplayName()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(128)
  name?: string;
  @OptionalNonNull()
  @IsEnum(CashFlowCategory)
  cashFlowCategory?: CashFlowCategory;
  @OptionalNonNull() @IsBoolean() isActive?: boolean;
  /** Only `CASH` can be assigned after creation (to a postable, debit-normal
   *  ASSET without a role). Singleton roles are create-only. */
  @ApiPropertyOptional({
    enum: ['CASH'],
    description:
      'Assign the CASH role to an existing postable, debit-normal ASSET account that has no role (e.g. a pre-existing bank account). Singleton roles are create-only.',
  })
  // Not @IsOptional: that also skips validation for `null`, which would let
  // `{ role: null }` through and clear the role. Only an absent key is skipped;
  // null (or anything but 'CASH') is a 400.
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['CASH'])
  role?: 'CASH';
}
