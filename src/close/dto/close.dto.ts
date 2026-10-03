import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '../../common/dto/limits';
import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CloseYearDto {
  @Type(() => Number)
  @IsInt()
  @Min(FISCAL_YEAR_MIN)
  @Max(FISCAL_YEAR_MAX)
  fiscalYear!: number;
}
