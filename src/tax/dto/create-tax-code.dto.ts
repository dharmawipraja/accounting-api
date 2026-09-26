import { IsEnum, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { TaxKind } from '@prisma/client';
import { NON_BLANK_MESSAGE } from '../../common/text/identifier';
import {
  DisplayName,
  IdentifierCode,
} from '../../common/validators/identifier-code';

/** code: NFKC + trimmed, no format/control characters (see
 *  common/text/identifier); name: trimmed, no format characters. Both
 *  non-blank. */
export class CreateTaxCodeDto {
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

  @IsEnum(TaxKind)
  kind!: TaxKind;

  /** Numeric decimal string, <= 3 integer digits and <= 6 dp, <= 10 chars (fits NUMERIC(9,6)); range (0,1) checked in the service. */
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{1,3}(\.\d{1,6})?$/, {
    message:
      'rate must be a numeric decimal string with at most 3 integer digits and up to 6 decimals, e.g. 0.11',
  })
  rate!: string;

  @IsUUID()
  taxAccountId!: string;
}
