import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaxableLineDto } from '../../tax/dto/calculate-tax.dto';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';
import { AllocationDto } from './create-payment.dto';

export type PreviewNature = 'SALE' | 'PURCHASE' | 'PAYMENT';

const TAXED: readonly PreviewNature[] = ['SALE', 'PURCHASE'];
const PAYMENT: readonly PreviewNature[] = ['PAYMENT'];

/** Fails when the field is present on a body whose `nature` is not one of
 *  `natures` — a field of the OTHER shape is a 400, never silently ignored
 *  (it would otherwise skip every validator, whitelisting included, and be
 *  copied into the append-only audit log). */
function OnlyForNature(natures: readonly PreviewNature[]): PropertyDecorator {
  return ValidateBy({
    name: 'onlyForNature',
    constraints: [natures],
    validator: {
      validate: (_value: unknown, args?: ValidationArguments) =>
        natures.includes((args?.object as PreviewJournalEntryDto).nature),
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property} is only allowed when nature is ${natures.join(' or ')}`,
    },
  });
}

/** Validate a nature-specific field when its nature applies (then required)
 *  OR whenever it is sent at all (then `OnlyForNature` rejects it for the
 *  other nature, and its shape is still validated). */
const validateFor =
  (natures: readonly PreviewNature[], key: keyof PreviewJournalEntryDto) =>
  (o: PreviewJournalEntryDto): boolean =>
    natures.includes(o.nature) || o[key] !== undefined;

/** Preview a document's journal entry, discriminated by `nature`:
 *  SALE/PURCHASE use the /tax/calculate shape; PAYMENT uses the payment shape. */
export class PreviewJournalEntryDto {
  @ApiProperty({ enum: ['SALE', 'PURCHASE', 'PAYMENT'] })
  @IsIn(['SALE', 'PURCHASE', 'PAYMENT'])
  nature!: PreviewNature;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'Intended posting date. When present, the preview also reproduces the ' +
      '409 a real post would give for a closed period or closed fiscal year.',
  })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  date?: string;

  // --- SALE | PURCHASE ---
  @ApiPropertyOptional({
    format: 'uuid',
    deprecated: true,
    description:
      'Deprecated and ignored: SALE/PURCHASE previews always settle to the ' +
      'AR/AP control account resolved by role (exactly what the post writes). ' +
      'Still accepted on SALE/PURCHASE (must be a UUID if sent) for backward ' +
      'compatibility; rejected (400) for PAYMENT.',
  })
  // Optional (null/absent skip validation) on SALE/PURCHASE; on PAYMENT ANY
  // sent value — `null` included — is validated and rejected, like every
  // other foreign-nature field (cf. validateFor).
  @ValidateIf((o: PreviewJournalEntryDto) =>
    TAXED.includes(o.nature)
      ? o.settlementAccountId != null
      : o.settlementAccountId !== undefined,
  )
  @IsUUID()
  @OnlyForNature(TAXED)
  settlementAccountId?: string;

  @ApiPropertyOptional({
    type: [TaxableLineDto],
    description: 'Required for SALE/PURCHASE; rejected (400) for PAYMENT',
  })
  @ValidateIf(validateFor(TAXED, 'lines'))
  @OnlyForNature(TAXED)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines?: TaxableLineDto[];

  // --- PAYMENT ---
  @ApiPropertyOptional({
    enum: ['RECEIPT', 'DISBURSEMENT'],
    description: 'Required for PAYMENT; rejected (400) for SALE/PURCHASE',
  })
  @ValidateIf(validateFor(PAYMENT, 'direction'))
  @OnlyForNature(PAYMENT)
  @IsIn(['RECEIPT', 'DISBURSEMENT'])
  direction?: 'RECEIPT' | 'DISBURSEMENT';

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required for PAYMENT; rejected (400) for SALE/PURCHASE',
  })
  @ValidateIf(validateFor(PAYMENT, 'cashAccountId'))
  @OnlyForNature(PAYMENT)
  @IsUUID()
  cashAccountId?: string;

  @ApiPropertyOptional({
    type: [AllocationDto],
    description: 'Required for PAYMENT; rejected (400) for SALE/PURCHASE',
  })
  @ValidateIf(validateFor(PAYMENT, 'allocations'))
  @OnlyForNature(PAYMENT)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}
