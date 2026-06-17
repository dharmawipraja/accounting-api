import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) {
      // Fail-closed in production; allow in dev/test for local convenience.
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new UnauthorizedException();
      }
      return true;
    }
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return true;
    }
    throw new UnauthorizedException();
  }
}
