/**
 * Route Registration
 * Central route configuration using dependency injection
 */

import container from '../../core/container/index.js';
import { createAccountDetailRoutes } from '../../modules/accountDetail/routes.js';
import { createAccountGeneralRoutes } from '../../modules/accountGeneral/routes.js';
import { createAuthRoutes } from '../../modules/auth/routes.js';
import { createLedgerRoutes } from '../../modules/ledgers/routes.js';
import { createPostingRoutes } from '../../modules/posting/routes.js';
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

  // Posting management routes
  const postingRoutes = createPostingRoutes(container);
  app.use(`${apiBase}/posting`, postingRoutes);

  // Account General management routes
  const accountGeneralRoutes = createAccountGeneralRoutes(container);
  app.use(`${apiBase}/accounts/general`, accountGeneralRoutes);

  // Account Detail management routes
  const accountDetailRoutes = createAccountDetailRoutes(container);
  app.use(`${apiBase}/accounts/detail`, accountDetailRoutes);

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
        posting: `${apiBase}/posting`,
        accountsGeneral: `${apiBase}/accounts/general`,
        accountsDetail: `${apiBase}/accounts/detail`
      }
    });
  });
}
