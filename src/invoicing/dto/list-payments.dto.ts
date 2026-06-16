import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class PaymentListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
