import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_WITH_PENDING_PASSWORD } from '../decorators/allow-with-pending-password.decorator';
import { AuthenticatedUser } from '../strategies/jwt.strategy';
import { PasswordChangeRequiredError } from '../../common/errors/domain-errors';

/** Global guard (after RolesGuard): a user with mustChangePassword=true may
 *  only hit @AllowWithPendingPassword() handlers. @Public routes never reach
 *  here with a user, so they are unaffected. */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user?.mustChangePassword) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WITH_PENDING_PASSWORD,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowed) return true;
    throw new PasswordChangeRequiredError(
      'Password change required before using the API',
    );
  }
}
