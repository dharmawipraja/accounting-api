import { ApiPropertyOptional } from '@nestjs/swagger';
import { CoretaxBuyerDocument } from '@prisma/client';
import { Npwp } from '../../common/validators/npwp';
import { OptionalNonNull } from '../../common/validators/optional-non-null';
import {
  IsBoolean,
  IsEnum,
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
  @IsOptional() @IsString() @MaxLength(32) @Npwp() npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isVendor?: boolean;
  @ApiPropertyOptional({
    enum: CoretaxBuyerDocument,
    default: 'TIN',
    description:
      'Coretax BuyerDocument: TIN (uses npwp), NATIONAL_ID (NIK), PASSPORT or OTHER.',
  })
  @IsOptional()
  @IsEnum(CoretaxBuyerDocument)
  buyerDocumentType?: CoretaxBuyerDocument;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 64,
    description:
      'NIK (16 digits) for NATIONAL_ID, passport / other document number otherwise; unused for TIN.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\S(.*\S)?$/, {
    message: 'buyerDocumentNumber must be trimmed and non-blank',
  })
  @MaxLength(64)
  buyerDocumentNumber?: string | null;
  @ApiPropertyOptional({
    example: '000000',
    description:
      'NITKU place-of-business suffix: BuyerIDTKU = npwp + this (6 digits).',
  })
  @OptionalNonNull()
  @Matches(/^\d{6}$/, { message: 'nitkuSuffix must be 6 digits' })
  nitkuSuffix?: string;
  @ApiPropertyOptional({
    example: 'IDN',
    description: 'ISO 3166-1 alpha-3 (Coretax BuyerCountry).',
  })
  @OptionalNonNull()
  @Matches(/^[A-Z]{3}$/, {
    message: 'country must be an ISO 3166-1 alpha-3 code, e.g. IDN',
  })
  country?: string;
}
