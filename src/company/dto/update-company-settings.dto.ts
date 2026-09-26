import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OptionalNonNull } from '../../common/validators/optional-non-null';

export class UpdateCompanySettingsDto {
  @OptionalNonNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName?: string;
  // npwp / address are nullable columns: `null` clears them.
  @IsOptional() @IsString() @MaxLength(32) npwp?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @OptionalNonNull() @IsInt() @Min(1) @Max(12) fiscalYearStartMonth?: number;
  @OptionalNonNull() @IsBoolean() segregationOfDutiesEnabled?: boolean;
  @OptionalNonNull() @IsBoolean() isPkp?: boolean;
}
