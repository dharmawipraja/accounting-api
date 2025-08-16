/**
 * Application Router
 * Central routing configuration using the new modular structure
 */

import { z } from 'zod';
import { accountsRoutes } from './modules/accounts/routes.js';
import { createAuthRoutes } from './modules/auth/index.js';
import { healthRoutes } from './modules/health/index.js';
import { ledgersRoutes } from './modules/ledgers/index.js';
import { userRoutes } from './modules/users/index.js';

/**
 * Register all application routes
 * @param {Object} fastify - Fastify instance
 */
export async function registerRoutes(fastify) {
  // Health and monitoring routes (no auth required)
  await fastify.register(healthRoutes);

  // API info endpoint
  fastify.get(
    '/api',
    {
      schema: {
        description: 'API Information',
        tags: ['API'],
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
            description: z.string(),
            timestamp: z.string()
          })
        }
      }
    },
    async () => {
      return {
        name: 'Accounting API',
        version: '1.0.0',
        description: 'A RESTful API for accounting system',
        timestamp: new Date().toISOString()
      };
    }
  );

  // Authentication routes
  const authRoutes = createAuthRoutes(process.env.JWT_SECRET || 'your-secret-key');
  await fastify.register(authRoutes, { prefix: '/auth' });

  // User management routes
  await fastify.register(userRoutes, { prefix: '/users' });

  // Account management routes (general and detail)
  await fastify.register(accountsRoutes, { prefix: '/accounts' });

  // Ledger management routes
  await fastify.register(ledgersRoutes, { prefix: '/ledgers' });
}
