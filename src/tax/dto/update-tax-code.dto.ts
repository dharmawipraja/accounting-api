import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';
import { OptionalNonNull } from '../../common/validators/optional-non-null';
import { NON_BLANK_MESSAGE } from '../../common/text/identifier';
import { DisplayName } from '../../common/validators/identifier-code';

export class UpdateTaxCodeDto {
  @OptionalNonNull()
  @DisplayName()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(128)
  name?: string;

  @OptionalNonNull()
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{1,3}(\.\d{1,6})?$/, {
    message:
      'rate must be a numeric decimal string with at most 3 integer digits and up to 6 decimals, e.g. 0.11',
  })
  rate?: string;

  @OptionalNonNull()
  @IsBoolean()
  isActive?: boolean;
}
