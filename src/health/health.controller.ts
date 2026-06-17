import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { Public } from '../auth/decorators/public.decorator';
import {
  HealthStatusDto,
  ReadinessStatusDto,
} from '../common/openapi/openapi.models';

// Probes must never be rate-limited — monitoring agents poll them frequently.
@SkipThrottle()
@ApiTags('Health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  @Public()
  @Get('health')
  @ApiOkResponse({ type: HealthStatusDto })
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOkResponse({ type: ReadinessStatusDto })
  async readiness(): Promise<{ status: string; db: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // Dependency down → 503 (not 200, not 500): the app is up but not ready.
      // The message names the failed dependency (it survives AllExceptionsFilter).
      throw new ServiceUnavailableException('Database unavailable');
    }
    if (this.redis) {
      try {
        await this.redis.ping();
      } catch {
        throw new ServiceUnavailableException('Redis unavailable');
      }
    }
    return { status: 'ok', db: 'up' };
  }
}
