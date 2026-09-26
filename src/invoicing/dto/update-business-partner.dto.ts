import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { OptionalNonNull } from '../../common/validators/optional-non-null';

export class UpdateBusinessPartnerDto {
  @OptionalNonNull() @IsString() @MaxLength(160) name?: string;
  // npwp / email / phone / address are nullable columns: `null` clears them.
  @IsOptional() @IsString() @MaxLength(32) npwp?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(32) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(255) address?: string | null;
  @OptionalNonNull() @IsBoolean() isCustomer?: boolean;
  @OptionalNonNull() @IsBoolean() isVendor?: boolean;
  @OptionalNonNull() @IsBoolean() isActive?: boolean;
}
