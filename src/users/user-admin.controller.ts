import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ErrorEnvelopeDto } from '../common/openapi/openapi.models';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { UserAdminService } from './user-admin.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
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
  @ApiConflictResponse({
    type: ErrorEnvelopeDto,
    description: 'A user with this email already exists',
  })
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
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.admin.getById(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  @ApiUnprocessableEntityResponse({
    type: ErrorEnvelopeDto,
    description: 'Self role-change/deactivation, or last active ADMIN',
  })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.admin.update(actor.id, id, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @ApiOkResponse({ type: CreateUserResponseDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CreateUserResponseDto> {
    return this.admin.resetPassword(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  @ApiUnprocessableEntityResponse({
    type: ErrorEnvelopeDto,
    description: 'Self-delete, or last active ADMIN',
  })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.admin.remove(actor.id, id);
  }
}
