import { IsBooleanString, IsOptional } from 'class-validator';

export class JournalPostQueryDto {
  @IsOptional() @IsBooleanString() post?: string;
}
