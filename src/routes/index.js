/**
 * API Routes Registry
 */

import { z } from 'zod';
import { checkDatabaseHealth, getDatabaseStats } from '../config/db-utils.js';
// ...existing code...

// Health and monitoring routes
export const healthRoutes = async fastify => {
  // Health check
  fastify.get(
    '/health',
    {
      schema: {
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            uptime: z.number(),
            version: z.string(),
            memory: z.object({ used: z.number(), total: z.number(), percentage: z.number() }),
            database: z.object({
              healthy: z.boolean(),
              version: z.string().optional(),
              connections: z.number().optional()
            })
          })
        }
      }
    },
    async (_request, _reply) => {
      const memUsage = process.memoryUsage();
      const memTotal = memUsage.heapTotal;
      const memUsed = memUsage.heapUsed;

      // Get database info using the Prisma client directly
      let dbInfo = { healthy: false };

      try {
        const dbHealth = await checkDatabaseHealth(fastify.prisma);
        dbInfo = { healthy: dbHealth.healthy };

        if (dbHealth.healthy) {
          try {
            const dbStats = await getDatabaseStats();
            dbInfo = {
              healthy: true,
              version: 'PostgreSQL',
              connections: dbStats.database.activeConnections,
              tableCount: dbStats.tables.total
            };
          } catch (error) {
            fastify.log.warn('Could not fetch database stats for health check:', error.message);
          }
        }
      } catch (error) {
        fastify.log.error('Database health check failed:', error.message);
        dbInfo = { healthy: false, error: 'Database unavailable' };
      }

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0',
        memory: {
          used: Math.round((memUsed / 1024 / 1024) * 100) / 100, // MB
          total: Math.round((memTotal / 1024 / 1024) * 100) / 100, // MB
          percentage: Math.round((memUsed / memTotal) * 10000) / 100
        },
        database: dbInfo
      };
    }
  );

  // Ready check for load balancers
  fastify.get('/ready', async (_request, _reply) => {
    try {
      const dbHealth = await checkDatabaseHealth(fastify.prisma);
      if (dbHealth.healthy) {
        return {
          status: 'ready',
          timestamp: new Date().toISOString(),
          checks: {
            database: 'healthy'
          }
        };
      } else {
        throw fastify.httpErrors.serviceUnavailable('Database unavailable');
      }
    } catch (error) {
      fastify.log.error('Readiness check failed:', error.message);
      throw fastify.httpErrors.serviceUnavailable('Database unavailable');
    }
  });

  // Liveness check
  fastify.get('/live', async (_request, _reply) => {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      pid: process.pid
    };
  });

  // Database statistics endpoint (development/monitoring)
  fastify.get('/db-stats', async (_request, _reply) => {
    try {
      const stats = await getDatabaseStats();
      return {
        success: true,
        data: stats
      };
    } catch (error) {
      fastify.log.error('Failed to get database statistics:', error);
      throw fastify.httpErrors.internalServerError('Failed to retrieve database statistics');
    }
  });
};

// API versioning routes
export const apiRoutes = async fastify => {
  // Register JWT
  await fastify.register(import('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'your-secret-key'
  });

  // Add JWT authentication helper
  fastify.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      fastify.log.warn('JWT verification failed:', err.message);
      throw reply.unauthorized('Authentication required');
    }
  });

  // API info
  fastify.get(
    '/api',
    {
      schema: {
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
            description: z.string(),
            endpoints: z.object({
              health: z.string(),
              ready: z.string(),
              live: z.string(),
              auth: z.string(),
              users: z.string()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const baseUrl = `${request.protocol}://${request.hostname}`;
      // Cache public API info for a short duration to reduce load
      // Respect the plugin's ETag handling; set Cache-Control for downstream caches
      try {
        reply.header('Cache-Control', 'public, max-age=300');
      } catch {
        /* ignore if reply not available */
      }
      return {
        name: 'Accounting API',
        version: process.env.npm_package_version || '1.0.0',
        description:
          'Production-ready accounting API with Fastify, Prisma, Zod validation, and JWT authentication',
        endpoints: {
          health: `${baseUrl}/health`,
          ready: `${baseUrl}/ready`,
          live: `${baseUrl}/live`,
          auth: `${baseUrl}/api/v1/auth`,
          users: `${baseUrl}/api/v1/users`
        }
      };
    }
  );

  // Register v1 API routes
  await fastify.register(
    async fastify => {
      fastify.get('/', async (_request, reply) => {
        // Small public cache for the root API summary
        try {
          reply.header('Cache-Control', 'public, max-age=300');
        } catch {
          /* ignore */
        }

        return {
          message: 'Accounting API v1 with Zod Validation and JWT Authentication',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          features: [
            'JWT Authentication',
            'Role-based Access Control',
            'Type-safe validation with Zod',
            'Comprehensive error handling',
            'Schema-driven development',
            'Full CRUD operations',
            'Pagination and filtering'
          ]
        };
      });

      // Import and register auth routes
      const { authRoutes } = await import('./auth.js');
      await fastify.register(authRoutes, { prefix: '/auth' });

      // Import and register user routes
      const { userRoutes } = await import('./users.js');
      await fastify.register(userRoutes, { prefix: '/users' });

      // Import and register account general routes
      const { accountGeneralRoutes } = await import('./accounts-general.js');
      await fastify.register(accountGeneralRoutes, { prefix: '/accounts-general' });

      // Import and register account detail routes
      const { accountDetailRoutes } = await import('./accounts-detail.js');
      await fastify.register(accountDetailRoutes, { prefix: '/accounts-detail' });

      // Import and register ledger routes
      const { ledgerRoutes } = await import('./ledgers.js');
      await fastify.register(ledgerRoutes, { prefix: '/ledgers' });

      // Add more route registrations here as you create them:
      // const { accountRoutes } = await import('./accounts.js');
      // await fastify.register(accountRoutes, { prefix: '/accounts' });

      // const { reportRoutes } = await import('./reports.js');
      // await fastify.register(reportRoutes, { prefix: '/reports' });
    },
    { prefix: '/api/v1' }
  );
};
