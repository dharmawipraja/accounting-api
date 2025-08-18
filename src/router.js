/**
 * Express Application Router
 * Central routing configuration for Express.js
 */

import { accountsRoutes } from './modules/accounts/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { ledgersRoutes } from './modules/ledgers/routes.js';
import { userRoutes } from './modules/users/routes.js';

/**
 * Register all application routes for Express
 * @param {Object} app - Express app instance
 */
export async function registerRoutes(app) {
  // Authentication routes
  app.use('/auth', authRoutes);

  // User management routes
  app.use('/users', userRoutes);

  // Account management routes (general and detail)
  app.use('/accounts', accountsRoutes);

  // Ledger management routes
  app.use('/ledgers', ledgersRoutes);
}
