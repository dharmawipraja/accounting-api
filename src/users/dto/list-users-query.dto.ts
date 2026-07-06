import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Role } from '../../auth/role.enum';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'])
  role?: Role;

  @IsOptional()
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';
}
