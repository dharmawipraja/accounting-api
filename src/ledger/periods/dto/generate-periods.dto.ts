import { IsInt, Max, Min } from 'class-validator';

export class GeneratePeriodsDto {
  @IsInt() @Min(2000) @Max(2200) fiscalYear!: number;
}
