import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MAX_TAX_CODES_PER_LINE } from '../../common/dto/limits';
import { IsMoneyString } from '../../common/validators/is-money-string';

/**
 * One line of a taxed trade document (sales invoice / purchase bill). Shared by the
 * create and update DTOs of both document types. `quantity`/`unitPrice` use the
 * canonical IsMoneyString validator (non-negative, up to 4 decimal places).
 */
export class DocumentLineDto {
  @IsString() @MaxLength(255) description!: string;
  @IsUUID() accountId!: string;
  @IsMoneyString() quantity!: string;
  @IsMoneyString() unitPrice!: string;
  @IsArray()
  @ArrayMaxSize(MAX_TAX_CODES_PER_LINE)
  @IsUUID('all', { each: true })
  taxCodeIds!: string[];
}
