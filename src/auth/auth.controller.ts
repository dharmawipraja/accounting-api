import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { THROTTLE, THROTTLE_TTL_MS } from '../config/throttle.config';
import { AuthService, TokenPair } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './strategies/jwt.strategy';
import { Roles } from './decorators/roles.decorator';
import { Role } from './role.enum';
import {
  AuthenticatedUserDto,
  ErrorEnvelopeDto,
  OkFlagDto,
  TokenPairDto,
} from '../common/openapi/openapi.models';

@ApiTags('Auth')
@ApiBearerAuth()
@ApiExtraModels(ErrorEnvelopeDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { ttl: THROTTLE_TTL_MS, limit: THROTTLE.login } })
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenPairDto })
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Throttle({ default: { ttl: THROTTLE_TTL_MS, limit: THROTTLE.refresh } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenPairDto })
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { ttl: THROTTLE_TTL_MS, limit: THROTTLE.refresh } })
  @Post('logout')
  @ApiOkResponse({ type: OkFlagDto })
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @ApiOkResponse({ type: OkFlagDto })
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ ok: true }> {
    return this.auth.logoutAll(user.id);
  }

  @Get('me')
  @ApiOkResponse({ type: AuthenticatedUserDto })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  // Phase 1 RBAC smoke surface — replace with a real admin endpoint later.
  @Roles(Role.ADMIN)
  @Get('admin-only')
  @ApiOkResponse({ type: OkFlagDto })
  adminOnly(): { ok: boolean } {
    return { ok: true };
  }
}
