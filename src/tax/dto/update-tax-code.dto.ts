import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';
import { OptionalNonNull } from '../../common/validators/optional-non-null';

export class UpdateTaxCodeDto {
  @OptionalNonNull()
  @IsString()
  @MaxLength(128)
  name?: string;

  @OptionalNonNull()
  @IsString()
  @Matches(/^\d+(\.\d{1,6})?$/, {
    message:
      'rate must be a numeric decimal string with up to 6 decimals, e.g. 0.11',
  })
  rate?: string;

  @OptionalNonNull()
  @IsBoolean()
  isActive?: boolean;
}
