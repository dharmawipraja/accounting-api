import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Non-blank after trim: at least one non-whitespace character. */
export const NON_BLANK = /\S/;
export const NON_BLANK_MESSAGE = '$property must not be blank';

export class CreateBusinessPartnerDto {
  @IsString()
  @Matches(NON_BLANK, { message: NON_BLANK_MESSAGE })
  @MaxLength(32)
  code!: string;
  @IsString()
  @Matches(NON_BLANK, { message: NON_BLANK_MESSAGE })
  @MaxLength(160)
  name!: string;
  @IsOptional() @IsString() @MaxLength(32) npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isVendor?: boolean;
}
