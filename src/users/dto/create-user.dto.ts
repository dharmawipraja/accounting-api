import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { Role } from '../../auth/role.enum';

export class CreateUserDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN']) role!: Role;
}
