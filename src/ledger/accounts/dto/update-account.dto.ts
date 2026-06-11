import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { CashFlowCategory } from '@prisma/client';

export class UpdateAccountDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
