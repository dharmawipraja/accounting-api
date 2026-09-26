import {
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../auth/role.enum';
import { OptionalNonNull } from '../../common/validators/optional-non-null';

export class UpdateUserDto {
  @OptionalNonNull() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @OptionalNonNull()
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'])
  role?: Role;
  @OptionalNonNull() @IsBoolean() isActive?: boolean;
}
