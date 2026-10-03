import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
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

  @ApiPropertyOptional({
    description:
      'PPN Output only — Coretax presentation: DPP Nilai Lain = 11/12 × DPP (PMK 131/2024). Does not change the computed tax.',
  })
  @OptionalNonNull()
  @IsBoolean()
  dppNilaiLain?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '12',
    description:
      'PPN Output only — statutory VATRate (%) shown on the faktur; null = derived from rate. rate × 100 must equal it (× 11/12 with dppNilaiLain).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,3}(\.\d{1,2})?$/, {
    message: 'coretaxVatRate must be a percent with up to 2 decimals, e.g. 12',
  })
  coretaxVatRate?: string | null;
}
