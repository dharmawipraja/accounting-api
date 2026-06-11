import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateTaxCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'rate must be a numeric decimal string like 0.11',
  })
  rate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
