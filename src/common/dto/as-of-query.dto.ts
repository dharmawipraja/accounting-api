import { IsDateString, IsOptional } from 'class-validator';

export class AsOfQueryDto {
  @IsOptional() @IsDateString() asOf?: string;
}
