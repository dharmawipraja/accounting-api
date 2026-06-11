import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateCompanySettingsDto {
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() npwp?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsInt() @Min(1) @Max(12) fiscalYearStartMonth?: number;
  @IsOptional() @IsBoolean() segregationOfDutiesEnabled?: boolean;
  @IsOptional() @IsBoolean() isPkp?: boolean;
}
