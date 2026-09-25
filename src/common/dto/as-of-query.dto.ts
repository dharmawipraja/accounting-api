import { IsBusinessDate } from '../validators/is-business-date';
import { IsDateString, IsOptional } from 'class-validator';

export class AsOfQueryDto {
  @IsOptional() @IsDateString() @IsBusinessDate() asOf?: string;
}
