import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JournalStatus, JournalSourceType } from '@prisma/client';
import { SearchQueryDto } from '../../../common/dto/search-query.dto';

export class JournalListQueryDto extends SearchQueryDto {
  @IsOptional() @IsEnum(JournalStatus) status?: JournalStatus;
  @IsOptional() @IsEnum(JournalSourceType) sourceType?: JournalSourceType;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
