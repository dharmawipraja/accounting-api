import { ApiPropertyOptional } from '@nestjs/swagger';
import { CoretaxItemType } from '@prisma/client';
import { Npwp } from '../../common/validators/npwp';
import {
  IsBoolean,
  IsEnum,
  Matches,
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
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0012345678901000',
    description:
      'Seller NPWP: 16 digits (punctuation stripped; a legacy 15-digit NPWP is stored as 0 + 15 digits).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Npwp()
  npwp?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @OptionalNonNull() @IsInt() @Min(1) @Max(12) fiscalYearStartMonth?: number;
  @OptionalNonNull() @IsBoolean() segregationOfDutiesEnabled?: boolean;
  @OptionalNonNull() @IsBoolean() isPkp?: boolean;
  @ApiPropertyOptional({
    example: '000000',
    description: 'Coretax NITKU suffix: SellerIDTKU = npwp + this (6 digits).',
  })
  @OptionalNonNull()
  @Matches(/^\d{6}$/, { message: 'nitkuSuffix must be 6 digits' })
  nitkuSuffix?: string;
  @ApiPropertyOptional({
    enum: CoretaxItemType,
    nullable: true,
    description: 'Default Coretax line type: A = goods, B = services.',
  })
  @IsOptional()
  @IsEnum(CoretaxItemType)
  coretaxDefaultItemType?: CoretaxItemType | null;
  @ApiPropertyOptional({
    example: '000000',
    description: 'Default Coretax item code (6 digits; 000000 = none).',
  })
  @OptionalNonNull()
  @Matches(/^\d{6}$/, { message: 'coretaxDefaultItemCode must be 6 digits' })
  coretaxDefaultItemCode?: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'UM.0018',
    description: 'Default Coretax unit code (UM.xxxx, DJP reference list).',
  })
  @IsOptional()
  @Matches(/^UM\.\d{4}$/, {
    message: 'coretaxDefaultUnitCode must look like UM.0018',
  })
  coretaxDefaultUnitCode?: string | null;
}
