import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RefreshTokenService } from './refresh-token.service';

/** Hourly cleanup of expired refresh-token rows. */
@Injectable()
export class RefreshTokenPurgeService {
  private readonly logger = new Logger(RefreshTokenPurgeService.name);

  constructor(private readonly refreshTokens: RefreshTokenService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const count = await this.refreshTokens.purgeExpired();
    if (count > 0) {
      this.logger.log(`Purged ${count} expired refresh tokens`);
    }
  }
}
