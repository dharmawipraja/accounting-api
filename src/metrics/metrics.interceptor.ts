import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx
      .switchToHttp()
      .getRequest<{ method: string; route?: { path?: string } }>();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const end = this.metrics.httpDuration.startTimer();
    return next.handle().pipe(
      tap({
        next: () =>
          end({
            method: req.method,
            route: req.route?.path ?? 'unmatched',
            status: String(res.statusCode),
          }),
        error: () =>
          end({
            method: req.method,
            route: req.route?.path ?? 'unmatched',
            status: String(res.statusCode || 500),
          }),
      }),
    );
  }
}
