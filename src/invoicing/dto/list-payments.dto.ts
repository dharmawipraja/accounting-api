import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

export class PaymentListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
