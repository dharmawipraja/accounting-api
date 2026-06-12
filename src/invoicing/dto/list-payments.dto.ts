import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';

export class PaymentListQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
