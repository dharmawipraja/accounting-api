// Custom timing and request-id plugins were removed in favor of
// community plugins: `fastify-response-time` and `fastify-request-id`.
// Keep this file for other exported middleware utilities.

// Export validation middleware
export { safeParse } from './validation.js';

// Export authentication middleware
export {
  authenticate,
  authorize,
  canManageUsers,
  checkNotDeleted,
  hashPassword,
  requireAdmin,
  requireAdminOrManager,
  requireOwnerOrAdmin,
  verifyPassword
} from './auth.js';
