import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CloseYearDto {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) fiscalYear!: number;
}
