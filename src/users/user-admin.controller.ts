import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { UserAdminService } from './user-admin.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import {
  CreateUserResponseDto,
  PaginatedUsersResponseDto,
  UserResponseDto,
} from './dto/user-response.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('users')
export class UserAdminController {
  constructor(private readonly admin: UserAdminService) {}

  @Post()
  @ApiCreatedResponse({ type: CreateUserResponseDto })
  create(@Body() dto: CreateUserDto): Promise<CreateUserResponseDto> {
    return this.admin.createWithTempPassword(dto);
  }

  @Get()
  @ApiOkResponse({ type: PaginatedUsersResponseDto })
  list(@Query() q: ListUsersQueryDto): Promise<PaginatedUsersResponseDto> {
    return this.admin.list(q);
  }

  @Get(':id')
  @ApiOkResponse({ type: UserResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.admin.getById(id);
  }
}
