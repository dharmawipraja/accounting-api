import { IsEnum, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { TaxKind } from '@prisma/client';

export class CreateTaxCodeDto {
  @IsString()
  @MaxLength(32)
  code!: string;

  @IsString()
  @MaxLength(128)
  name!: string;

  @IsEnum(TaxKind)
  kind!: TaxKind;

  /** Numeric decimal string, max 6 dp (matches NUMERIC(9,6)); range (0,1) checked in the service. */
  @IsString()
  @Matches(/^\d+(\.\d{1,6})?$/, {
    message:
      'rate must be a numeric decimal string with up to 6 decimals, e.g. 0.11',
  })
  rate!: string;

  @IsUUID()
  taxAccountId!: string;
}
