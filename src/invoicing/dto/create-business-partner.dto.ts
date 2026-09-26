import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { NON_BLANK_MESSAGE } from '../../common/text/identifier';
import {
  DisplayName,
  IdentifierCode,
} from '../../common/validators/identifier-code';

/** code: NFKC + trimmed, no format/control characters, non-blank; name:
 *  trimmed, no format characters, non-blank (see common/text/identifier).
 *  The non-blank regex is written inline (`/\S/`) on each `@Matches` so the
 *  Swagger CLI plugin can read the literal and emit `pattern: "\\S"` in the
 *  OpenAPI schema (it cannot resolve a shared constant). */
export class CreateBusinessPartnerDto {
  @IdentifierCode()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(32)
  code!: string;
  @DisplayName()
  @IsString()
  @Matches(/\S/, { message: NON_BLANK_MESSAGE })
  @MaxLength(160)
  name!: string;
  @IsOptional() @IsString() @MaxLength(32) npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isVendor?: boolean;
}
