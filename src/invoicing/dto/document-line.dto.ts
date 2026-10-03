import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateBy,
  type ValidationArguments,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { MAX_TAX_CODES_PER_LINE } from '../../common/dto/limits';
import { IsMoneyString } from '../../common/validators/is-money-string';

/** 400 when the line also carries a `discountPercent` — a line's discount is
 *  a percent OR a fixed amount, never both. */
const NotWithDiscountPercent = (): PropertyDecorator =>
  ValidateBy({
    name: 'notWithDiscountPercent',
    validator: {
      validate: (_v: unknown, args?: ValidationArguments) =>
        (args?.object as DocumentLineDto).discountPercent == null,
      defaultMessage: () =>
        'discountAmount and discountPercent are mutually exclusive',
    },
  });

/** 400 unless a decimal string in [0, 100] with up to 4 dp. */
const PercentString = (): PropertyDecorator =>
  ValidateBy({
    name: 'percentString',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' &&
        /^\d{1,3}(\.\d{1,4})?$/.test(v) &&
        new Prisma.Decimal(v).lte(100),
      defaultMessage: () =>
        'discountPercent must be a decimal string between 0 and 100 with up to 4 decimal places',
    },
  });

/**
 * One line of a taxed trade document (sales invoice / purchase bill). Shared by the
 * create and update DTOs of both document types. `quantity`/`unitPrice` use the
 * canonical IsMoneyString validator (non-negative, up to 4 decimal places).
 * An optional discount — `discountPercent` OR `discountAmount` — is taken off
 * qty × unitPrice BEFORE tax; the line `amount` (the tax base) is net of it.
 */
export class DocumentLineDto {
  @IsString() @MaxLength(255) description!: string;
  @IsUUID() accountId!: string;
  @IsMoneyString() quantity!: string;
  @IsMoneyString() unitPrice!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '10',
    pattern: '^\\d{1,3}(\\.\\d{1,4})?$',
    description:
      'Line discount as a percent of qty × unitPrice (0–100, up to 4 dp). Mutually exclusive with discountAmount.',
  })
  @IsOptional()
  @PercentString()
  discountPercent?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '5000.0000',
    description:
      'Line discount as a fixed amount (≤ qty × unitPrice). Mutually exclusive with discountPercent.',
  })
  @IsOptional()
  @IsMoneyString()
  @NotWithDiscountPercent()
  discountAmount?: string | null;
  @IsArray()
  @ArrayMaxSize(MAX_TAX_CODES_PER_LINE)
  @IsUUID('all', { each: true })
  taxCodeIds!: string[];
}
