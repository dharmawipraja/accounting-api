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
  @IsOptional() @IsString() @MaxLength(32) npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @OptionalNonNull() @IsBoolean() isCustomer?: boolean;
  @OptionalNonNull() @IsBoolean() isVendor?: boolean;
  @OptionalNonNull() @IsBoolean() isActive?: boolean;
}
