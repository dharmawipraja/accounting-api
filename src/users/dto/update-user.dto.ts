import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../auth/role.enum';

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional()
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'])
  role?: Role;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
