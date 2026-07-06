import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITH_PENDING_PASSWORD = 'allowWithPendingPassword';

/** Handlers a user may call while mustChangePassword is set
 *  (change-password itself, /auth/me, logout). */
export const AllowWithPendingPassword = () =>
  SetMetadata(ALLOW_WITH_PENDING_PASSWORD, true);
