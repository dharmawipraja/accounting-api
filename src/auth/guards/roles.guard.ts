import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Role } from '../role.enum';
import { AuthenticatedUser } from '../strategies/jwt.strategy';
import {
  ForbiddenDomainError,
  UnauthorizedDomainError,
} from '../../common/errors/domain-errors';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) {
      // Unreachable in normal flow — JwtAuthGuard rejects unauthenticated
      // requests first — but assert it rather than emit a misleading 403.
      throw new UnauthorizedDomainError('Authentication required');
    }
    if (!required.includes(user.role)) {
      // The role matrix stays server-side: log it for operators, but never
      // disclose which roles would have been accepted to the caller.
      this.logger.warn(
        `Forbidden: user ${user.id} (${user.role}) lacks one of [${required.join(', ')}] for ${context.getClass().name}.${context.getHandler().name}`,
      );
      throw new ForbiddenDomainError('Insufficient role');
    }
    return true;
  }
}
