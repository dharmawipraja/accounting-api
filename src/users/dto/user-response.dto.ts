import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['VIEWER', 'ACCOUNTANT', 'APPROVER', 'ADMIN'] })
  role!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() mustChangePassword!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class CreateUserResponseDto {
  @ApiProperty({ type: UserResponseDto }) user!: UserResponseDto;
  @ApiProperty({
    description: 'Shown exactly once — the user must change it on first login.',
  })
  tempPassword!: string;
}

export class PaginatedUsersResponseDto {
  @ApiProperty({ type: [UserResponseDto] }) data!: UserResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
