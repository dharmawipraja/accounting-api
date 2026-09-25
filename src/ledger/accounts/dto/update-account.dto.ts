import { IsBoolean, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CashFlowCategory } from '@prisma/client';

export class UpdateAccountDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Only `CASH` can be assigned after creation (to a postable, debit-normal
   *  ASSET without a role). Singleton roles are create-only. */
  @ApiPropertyOptional({
    enum: ['CASH'],
    description:
      'Assign the CASH role to an existing postable, debit-normal ASSET account that has no role (e.g. a pre-existing bank account). Singleton roles are create-only.',
  })
  @IsOptional()
  @IsIn(['CASH'])
  role?: 'CASH';
}
