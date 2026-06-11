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

  /** Must be a numeric decimal string; range (0,1) validated in service. */
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'rate must be a numeric decimal string like 0.11',
  })
  rate!: string;

  @IsUUID()
  taxAccountId!: string;
}
