/**
 * Route Registration
 * Central route configuration using dependency injection
 */

import container from '../../core/container/index.js';
import { createAccountRoutes } from '../../modules/accounts/routes.js';
import { createAuthRoutes } from '../../modules/auth/routes.js';
import { createLedgerRoutes } from '../../modules/ledgers/routes.js';
import { createUserRoutes } from '../../modules/users/routes.js';

/**
 * Register all application routes
 * @param {express.Application} app - Express application
 */
export async function registerRoutes(app) {
  // API base path
  const apiBase = '/api/v1';

  // Authentication routes
  const authRoutes = createAuthRoutes(container);
  app.use(`${apiBase}/auth`, authRoutes);

  // User management routes
  const userRoutes = createUserRoutes(container);
  app.use(`${apiBase}/users`, userRoutes);

  // Ledger management routes
  const ledgerRoutes = createLedgerRoutes(container);
  app.use(`${apiBase}/ledgers`, ledgerRoutes);

  // Account management routes
  const accountRoutes = createAccountRoutes(container);
  app.use(`${apiBase}/accounts`, accountRoutes);

  // Root API endpoint
  app.get('/api', (req, res) => {
    res.json({
      success: true,
      message: 'Accounting API v1',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        ready: '/ready',
        live: '/live',
        auth: `${apiBase}/auth`,
        users: `${apiBase}/users`,
        ledgers: `${apiBase}/ledgers`,
        accounts: `${apiBase}/accounts`
      }
    });
  });
}
