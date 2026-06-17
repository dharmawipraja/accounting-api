import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdempotencyService } from './idempotency.service';

/** Hourly cleanup of completed idempotency keys past their retention window. */
@Injectable()
export class IdempotencyPurgeService {
  private readonly logger = new Logger(IdempotencyPurgeService.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const count = await this.idempotency.purgeCompleted();
    if (count > 0) {
      this.logger.log(`Purged ${count} completed idempotency keys`);
    }
  }
}
