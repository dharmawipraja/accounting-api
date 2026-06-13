import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../common/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { HealthStatusDto, ReadinessStatusDto } from '../common/openapi/openapi.models';

// Probes must never be rate-limited — monitoring agents poll them frequently.
@SkipThrottle()
@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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
      throw new HttpException(
        { status: 'error', db: 'down' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', db: 'up' };
  }
}
