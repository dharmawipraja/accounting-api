import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class JournalPostQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  post?: boolean;
}
