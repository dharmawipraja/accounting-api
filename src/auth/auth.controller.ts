import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, TokenPair } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './strategies/jwt.strategy';
import { Roles } from './decorators/roles.decorator';
import { Role } from './role.enum';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({
    default: {
      ttl: 60_000,
      limit: Number(process.env.THROTTLE_LOGIN_LIMIT) || 10,
    },
  })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Throttle({
    default: {
      ttl: 60_000,
      limit: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30,
    },
  })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  // Phase 1 RBAC smoke surface — replace with a real admin endpoint later.
  @Roles(Role.ADMIN)
  @Get('admin-only')
  adminOnly(): { ok: boolean } {
    return { ok: true };
  }
}
