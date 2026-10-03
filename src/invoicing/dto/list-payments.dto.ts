import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

export class PaymentListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
  /** `true`: only POSTED payments with an unapplied (advance) balance — the
   *  partner's open credit (combine with `partnerId` / `direction`).
   *  `false`: only payments without one. */
  @IsOptional() @IsIn(['true', 'false']) unapplied?: 'true' | 'false';
}
